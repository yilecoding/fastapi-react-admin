"""数据变更工具（#260）：「谁、什么时候，把哪个对象的哪个字段从什么改成了什么」。

去「数据变更」页查，人得先选对象类型、再填对象 ID —— 而 ID 还得去别的页面找。问一句「谁改了张伟的部门」就该拿到答案。

和页面同一个口径：权限码 `log:change:list`，**不按数据权限过滤**（#260 拍板：看的人要的是全量审计）。
"""

from datetime import timedelta
from typing import Any

from sqlalchemy import Select, and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_data_change import data_change_dao
from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import DataChange, User
from backend.common.data_change import registry
from backend.plugin.ai.core.registry import ai_tool
from backend.utils.timezone import timezone

# 给模型看的样本量，不是分页（同 user_list）
_MAX_ROWS = 30
#: 集合字段（角色的菜单权限…）一次列多少个成员。存权限矩阵一次能动上百个菜单
_MAX_MEMBERS = 20
#: 名字最多对上几个对象。再多说明名字太泛（「测试」），让模型回去问清楚
_MAX_OBJECTS = 10
#: 🔴 只说「改过」、不给值的字段：返回的东西原样进模型上下文、发给供应商。邮箱、手机号能直接定位到人，
#: `user_list` 同样不返回它们（要看去页面上看）。密码这类敏感列在审计表里本来就只记了「改过」
_PERSONAL = frozenset({'email', 'phone'})


def _entity_type(value: str | None) -> str | None:
    if not value:
        return None
    registry.load_data_change_extensions()
    text = value.strip()
    for key, spec in registry.ENTITIES.items():
        if text in (key, spec.title):
            return key
    options = '、'.join(f'{spec.title}（{key}）' for key, spec in registry.ENTITIES.items())
    raise ValueError(f'不认识的对象类型「{text}」，可选：{options}')


def _field(entity: str | None, value: str | None) -> str | None:
    """字段：人说的是「部门」，库里记的是 `dept_id`。代号和中文名都认"""
    if not value:
        return None
    registry.load_data_change_extensions()
    text = value.strip()
    names: dict[str, str] = {}
    # describe() 里是「这个对象记哪些字段」的全集（普通列 + 关联表 / 子表折叠出来的集合字段）
    for item in registry.describe():
        if entity is None or item['entity'] == entity:
            names.update({f['field']: f['label'] for f in item['fields']})
    for code, label in names.items():
        if text in (code, label):
            return code
    raise ValueError(f'不认识的字段「{text}」，可选：{"、".join(sorted(set(names.values())))}')


async def _objects(db: AsyncSession, entity: str | None, name: str) -> dict[tuple[str, int], str]:
    """名字 → {(对象类型, ID): 名字}。

    先按变更记录里**当时的**名字找：改过名的对象，旧名字也认得出来，而且找到之后按 ID 取，
    改名前后的记录一起带出来。用户再按昵称找一遍 —— 人说的多半是「张伟」，记录里存的是用户名。
    按昵称找走 `user_dao`（数据范围由 dispatcher 锚定），不 bypass
    """
    stmt = (
        select(DataChange.entity_type, DataChange.entity_id, DataChange.entity_label)
        .where(DataChange.entity_label == name, DataChange.entity_id.is_not(None))
        .distinct()
        .limit(_MAX_OBJECTS + 1)
    )
    if entity is not None:
        stmt = stmt.where(DataChange.entity_type == entity)
    found: dict[tuple[str, int], str] = {(t, i): label for t, i, label in (await db.execute(stmt)).all()}
    if entity in (None, 'user'):
        for user in await user_dao.select_models(db, User.nickname == name, User.deleted == 0):
            found.setdefault(('user', user.id), user.username)
    if len(found) > _MAX_OBJECTS:
        raise ValueError(f'叫「{name}」的对象太多了，请让用户说得更具体些（比如说明是用户、部门还是角色）')
    return found


def _member(m: dict[str, Any]) -> str:
    return str(m.get('label') or m.get('id'))


def _change(item: dict[str, Any], *, created: bool) -> dict[str, Any]:
    out: dict[str, Any] = {'field': item.get('label') or item.get('field')}
    if item.get('secret') or item.get('field') in _PERSONAL:
        out['value'] = '已修改（不给出具体值）'
    elif item.get('varies'):
        out['value'] = '每一行改成的值不一样'
    elif 'added' in item or 'removed' in item:
        for side in ('added', 'removed'):
            members = item.get(side) or []
            out[side] = [_member(m) for m in members[:_MAX_MEMBERS]]
            if len(members) > _MAX_MEMBERS:
                out[f'{side}_more'] = len(members) - _MAX_MEMBERS
    else:
        # 取值的中文名（「停用」）/ 引用的名字（部门名）优先：模型拿到 `dept_id: 2048…` 什么都说不出来
        if not created:
            out['old'] = item.get('old_label', item.get('old'))
        out['new'] = item.get('new_label', item.get('new'))
    return out


def _record(r: DataChange) -> dict[str, Any]:
    spec = registry.ENTITIES.get(r.entity_type)
    title = spec.title if spec else r.entity_type
    created = r.action in ('create', 'bulk')
    return {
        'time': r.created_time.isoformat() if r.created_time else None,
        'object': f'{title}（批量，{r.entity_label} 条）' if r.action == 'bulk' else f'{title}「{r.entity_label}」',
        'object_id': str(r.entity_id) if r.entity_id is not None else None,  # 雪花 ID 一律字符串（硬纪律 6）
        'action': registry.ACTIONS.get(r.action, r.action),
        'actor': r.actor_name or '系统',
        'source': registry.SOURCES.get(r.source, r.source),
        'changes': [_change(c, created=created) for c in r.changes or []],
    }


@ai_tool(
    name='data_change_history',
    description=(
        '查数据变更记录：谁、什么时候、把哪个对象的哪个字段从什么改成了什么（用户 / 部门 / 角色 / 菜单 / 参数配置）。'
        '用户问「谁改了张伟的部门」「这个角色最近被改过什么」「admin 昨天改了哪些东西」'
        '「某某的手机号什么时候换的」时用它。'
        'name 直接填用户说的名字（用户名或昵称、部门名、角色名、菜单标题、参数键名都行），工具会自己找，'
        '不要先用 user_list 等工具去查 ID；对象类型和字段填中文名或代号都行。'
        '结果按时间从新到旧；手机号、邮箱、密码只说改过，不给具体值'
    ),
    domain='log',
    perm='log:change:list',
)
async def data_change_history(
    db: AsyncSession,
    name: str | None = None,
    entity_type: str | None = None,
    field: str | None = None,
    actor: str | None = None,
    recent_days: int | None = None,
) -> dict[str, Any]:
    registry.load_data_change_extensions()
    entity = _entity_type(entity_type)
    field_code = _field(entity, field)
    objects: dict[tuple[str, int], str] = {}
    if name and name.strip():
        objects = await _objects(db, entity, name.strip())
        if not objects:
            raise ValueError(
                f'没有找到叫「{name.strip()}」的对象的变更记录（按名字精确匹配：用户填用户名或昵称，'
                '部门 / 角色填名称，菜单填标题，参数填键名）。也可能是它从来没被改过'
            )
    start = timezone.now() - timedelta(days=recent_days) if recent_days else None
    stmt: Select = await data_change_dao.get_select(
        entity_type=entity, field=field_code, actor=actor or None, start_time=start
    )
    if objects:
        stmt = stmt.where(or_(*(and_(DataChange.entity_type == t, DataChange.entity_id == i) for t, i in objects)))
    rows = (await db.execute(stmt.limit(_MAX_ROWS))).scalars().all()
    return {
        'objects': [
            {'type': registry.ENTITIES[t].title if t in registry.ENTITIES else t, 'name': label, 'id': str(i)}
            for (t, i), label in objects.items()
        ]
        or None,
        'total_returned': len(rows),
        'truncated': len(rows) == _MAX_ROWS,
        'records': [_record(r) for r in rows],
    }
