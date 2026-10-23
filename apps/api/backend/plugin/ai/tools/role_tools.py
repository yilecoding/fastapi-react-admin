"""角色域工具。"""

from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_menu import menu_dao
from backend.app.admin.crud.crud_role import role_dao
from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import Menu, Role, User
from backend.app.admin.model.m2m import user_role
from backend.app.admin.schema.role import CreateRoleParam, UpdateRoleMenuParam, UpdateRoleParam
from backend.app.admin.service.role_service import role_service
from backend.common.enums import MenuType, StatusType
from backend.plugin.ai.core.ports import RunContext
from backend.plugin.ai.core.registry import ai_tool


@ai_tool(
    name='role_list',
    description='获取系统角色列表，返回角色 ID、名称、编码、状态。用户问"有哪些角色/某个角色在不在"时用它。',
    domain='role',
    # 复用接口上同一个权限码。界面上看不到角色列表的人，通过 AI 也看不到。
    perm='sys:role:list',
)
async def role_list(db: AsyncSession) -> list[dict[str, Any]]:
    """走 service 层，不碰 DAO。

    数据范围**自动**继承调用者：`role_dao` 是 `DataScopedCRUD`，
    当前用户由 `jwt_auth_middleware` 写进了 ContextVar，这里什么都不用做就是对的。
    反过来说，谁要是在这里加一句 `bypass_data_scope()`，受限用户就会通过 AI 看到全量角色。
    """
    roles = await role_service.get_all(db=db)
    return [
        {
            # 🔴 雪花 ID 必须转字符串（硬纪律 6）。直接给 int，模型在回答里
            # 复述一遍就可能丢精度，而用户拿着那个错 ID 去操作会命中另一条记录。
            'id': str(role.id),
            'name': role.name,
            'code': role.code,
            'status': role.status,
            'remark': role.remark,
        }
        for role in roles
    ]


# ---------------------------------------------------------------------------
# 变更类工具（约定同 `dept_tools.py` 那一段：入参构造 admin 的 Param、预演和执行共用
# service 的 `check_*`、提交后的动作挂 `ctx.background_tasks`）
# ---------------------------------------------------------------------------

_ROLE_ID_HINT = '角色 ID 是字符串（雪花 ID），先用 role_list 查到再传，不要自己编'
_MENU_ID_HINT = '菜单 ID 是字符串，先用 menu_list 查到再传，不要自己编'
#: 预演里最多逐条列多少项，再多就只给个数 —— 收回一整个目录时下面可能挂着几十个按钮
_MAX_LISTED = 30


def _label(role: Role) -> str:
    return f'「{role.name}」（编码 {role.code}）'


def _update_param(role: Role, **changes: Any) -> UpdateRoleParam:
    """只带两个必填项。没传的字段（「过滤数据权限」、备注）不会被写：DAO 的更新是
    `model_dump(exclude_unset=True)` —— 变异实测过，把它们从这里拿掉，读回来照样是原值"""
    return UpdateRoleParam(**{'name': role.name, 'status': role.status, **changes})


async def _preview_create(db: AsyncSession, name: str, code: str, remark: str | None = None) -> str:
    obj = CreateRoleParam(name=name, code=code, status=StatusType.enable, remark=remark)
    await role_service.check_create(db=db, obj=obj)
    return f'将新建角色「{obj.name}」（编码 {obj.code}），建好后还没有任何菜单权限'


@ai_tool(
    name='role_create',
    description=(
        '新建一个角色（启用状态，还没有任何菜单权限，要另用 role_update_menus 授权）。会先请用户确认再执行。'
        'code 是角色编码（大写字母开头，只含大写字母、数字、下划线，2-32 位，创建后不可改）。'
    ),
    domain='role',
    perm='sys:role:add',
    mutating=True,
    preview=_preview_create,
)
async def role_create(db: AsyncSession, name: str, code: str, remark: str | None = None) -> dict[str, Any]:
    obj = CreateRoleParam(name=name, code=code, status=StatusType.enable, remark=remark)
    await role_service.create(db=db, obj=obj)
    return {'name': obj.name, 'code': obj.code}


async def _preview_rename(db: AsyncSession, role_id: str, new_name: str) -> str:
    role = await role_service.get(db=db, pk=int(role_id))
    obj = _update_param(role, name=new_name)
    if role.name == obj.name:
        raise ValueError(f'角色已经叫「{role.name}」了，不需要改')
    await role_service.check_update(db=db, pk=role.id, obj=obj)
    return f'将把角色{_label(role)}改名为「{obj.name}」'


@ai_tool(
    name='role_rename',
    description=f'修改角色名称（只改名称，不动编码、状态、菜单权限）。会先请用户确认再执行。{_ROLE_ID_HINT}。',
    domain='role',
    perm='sys:role:edit',
    mutating=True,
    preview=_preview_rename,
)
async def role_rename(db: AsyncSession, ctx: RunContext, role_id: str, new_name: str) -> dict[str, Any]:
    role = await role_service.get(db=db, pk=int(role_id))
    old_name = role.name
    obj = _update_param(role, name=new_name)
    await role_service.update(db=db, background_tasks=ctx.background_tasks, pk=role.id, obj=obj)
    return {'role_id': role_id, 'old_name': old_name, 'new_name': obj.name}


async def _member_count(db: AsyncSession, role_id: int) -> int:
    """拥有这个角色、且调用者看得见的用户数（`user_dao` 在调用者的数据范围里查，和界面上成员面板同一个口径）"""
    members = select(user_role.c.user_id).where(user_role.c.role_id == role_id)
    return len(await user_dao.select_models(db, User.id.in_(members), User.deleted == 0))


async def _preview_set_status(db: AsyncSession, role_id: str, *, enabled: bool) -> str:
    role = await role_service.get(db=db, pk=int(role_id))
    obj = _update_param(role, status=StatusType.enable if enabled else StatusType.disable)
    if role.status == obj.status:
        raise ValueError(f'角色{_label(role)}已经是{"启用" if enabled else "停用"}状态，不需要改')
    await role_service.check_update(db=db, pk=role.id, obj=obj)
    members = await _member_count(db, role.id)
    if enabled:
        return f'将启用角色{_label(role)}：拥有它的用户（你能看到的有 {members} 个）会重新获得它给的菜单和权限'
    return (
        f'将停用角色{_label(role)}：拥有它的用户（你能看到的有 {members} 个）会失去它给的菜单和权限，'
        '他们的其它角色不受影响'
    )


@ai_tool(
    name='role_set_status',
    description=(
        '启用或停用一个角色（enabled=true 启用，false 停用）。停用后拥有它的用户立刻失去它给的菜单和权限。'
        f'会先请用户确认再执行。{_ROLE_ID_HINT}。'
    ),
    domain='role',
    perm='sys:role:edit',
    mutating=True,
    preview=_preview_set_status,
)
async def role_set_status(db: AsyncSession, ctx: RunContext, role_id: str, *, enabled: bool) -> dict[str, Any]:
    role = await role_service.get(db=db, pk=int(role_id))
    obj = _update_param(role, status=StatusType.enable if enabled else StatusType.disable)
    await role_service.update(db=db, background_tasks=ctx.background_tasks, pk=role.id, obj=obj)
    return {'role_id': role_id, 'name': role.name, 'status': 'enabled' if enabled else 'disabled'}


# ── 菜单权限：增量授予 / 收回 ─────────────────────────────────────────────────


def _ids(raw: list[str]) -> set[int]:
    try:
        return {int(x) for x in raw}
    except ValueError as e:
        raise ValueError(f'菜单 ID 必须是数字字符串：{raw}') from e


def _menu_label(menu: Menu, menus: dict[int, Menu]) -> str:
    """按钮的标题到处都是「新增」「删除」，单写分不清是哪一页的：前面带上所属菜单"""
    title = menu.title
    if menu.type == MenuType.button and menu.parent_id in menus:
        title = f'{menus[menu.parent_id].title} › {title}'
    return f'{title}（{menu.perms}）' if menu.perms else title


def _ancestors(menu_id: int, menus: dict[int, Menu]) -> set[int]:
    out: set[int] = set()
    parent = menus[menu_id].parent_id
    while parent in menus and parent not in out:
        out.add(parent)
        parent = menus[parent].parent_id
    return out


def _descendants(menu_id: int, menus: dict[int, Menu]) -> set[int]:
    children: dict[int, list[int]] = {}
    for m in menus.values():
        if m.parent_id is not None:
            children.setdefault(m.parent_id, []).append(m.id)
    out: set[int] = set()
    stack = [menu_id]
    while stack:
        for child in children.get(stack.pop(), []):
            if child not in out:
                out.add(child)
                stack.append(child)
    return out


async def _menu_plan(
    db: AsyncSession, role_id: str, grant_menu_ids: list[str], revoke_menu_ids: list[str]
) -> tuple[Role, set[int], set[int], set[int], set[int], dict[int, Menu]]:
    """算出改完之后的菜单集合。返回（角色, 新集合, 新增, 收回, 自动带上的, 全部菜单）

    🔴 **授予连同上级一起**：只给按钮不给它所在的页面，权限码生效了、页面却进不去（侧边栏挂不上孤儿）。
    🔴 **收回连同下级一起**：权限码是逐个菜单算的（`rbac.collect_allowed_perms` 只看菜单自己启没启用，
    不看上级），只收「用户管理」、留着它下面的按钮，`sys:user:del` 照样生效 —— 接口还能调，界面上却看不出来。
    已经被删掉的菜单不算在「现有」里（同权限矩阵：树只从没删的菜单建，保存时那些失效的关联自然清掉）。
    """
    role = await role_service.get(db=db, pk=int(role_id))
    menus = {m.id: m for m in await menu_dao.get_all(db, title=None, status=None)}
    grant, revoke = _ids(grant_menu_ids), _ids(revoke_menu_ids)
    if not grant and not revoke:
        raise ValueError('要授予和要收回的菜单都是空的')
    if unknown := (grant | revoke) - menus.keys():
        raise ValueError(f'这些菜单 ID 不存在：{sorted(str(i) for i in unknown)}。{_MENU_ID_HINT}')
    if both := grant & revoke:
        raise ValueError(f'同一个菜单不能既授予又收回：{[menus[i].title for i in both]}')

    to_add, to_remove = set(grant), set(revoke)
    for mid in grant:
        to_add |= _ancestors(mid, menus)
    for mid in revoke:
        to_remove |= _descendants(mid, menus)
    if clash := to_add & to_remove:
        names = '、'.join(_menu_label(menus[i], menus) for i in sorted(clash))
        raise ValueError(f'要授予的菜单和要收回的菜单互相包含（{names}），先分两次说清楚')

    current = {m.id for m in (await role_dao.get_menus(db, role.id) or []) if m.id in menus}
    new = (current | to_add) - to_remove
    added, removed = new - current, current - new
    if not added and not removed:
        raise ValueError(f'角色{_label(role)}的菜单不会有任何变化：要授予的已经都有了，要收回的本来就没有')
    implied = (added - grant) | (removed - revoke)
    return role, new, added, removed, implied, menus


def _listing(ids: set[int], implied: set[int], menus: dict[int, Menu]) -> str:
    ordered = sorted(ids, key=lambda i: (menus[i].parent_id or 0, menus[i].sort, i))
    items = [_menu_label(menus[i], menus) + ('（一并带上）' if i in implied else '') for i in ordered[:_MAX_LISTED]]
    more = f' …等共 {len(ids)} 项' if len(ids) > _MAX_LISTED else ''
    return '、'.join(items) + more


async def _preview_update_menus(
    db: AsyncSession, role_id: str, grant_menu_ids: list[str] | None = None, revoke_menu_ids: list[str] | None = None
) -> str:
    plan = await _menu_plan(db, role_id, grant_menu_ids or [], revoke_menu_ids or [])
    role, new, added, removed, implied, menus = plan
    await role_service.check_role_menu(db=db, pk=role.id, menu_ids=UpdateRoleMenuParam(menus=sorted(new)))
    lines = [f'将修改角色{_label(role)}的菜单权限：']
    if added:
        lines.append(f'新增 {len(added)} 项：{_listing(added, implied, menus)}')
    if removed:
        lines.append(f'收回 {len(removed)} 项：{_listing(removed, implied, menus)}')
    if implied:
        lines.append(
            '「一并带上」的是：授予时补上的上级（不补的话页面进不去）、收回时连带的下级（不收的话它们的权限码照样生效）'
        )
    return '\n'.join(lines)


@ai_tool(
    name='role_update_menus',
    description=(
        '给角色授予 / 收回菜单权限（增量：只动列出来的，其余保持不变）。会先请用户确认再执行。'
        '授予时会自动带上它的上级菜单（否则页面进不去）；收回时会连同它下面的子菜单和按钮一起收回'
        '（否则那些按钮的权限码照样生效）。'
        'grant_menu_ids 是要授予的菜单 ID 列表，revoke_menu_ids 是要收回的，至少给一个。'
        f'{_ROLE_ID_HINT}；{_MENU_ID_HINT}。'
    ),
    domain='role',
    perm='sys:role:menu:edit',
    mutating=True,
    preview=_preview_update_menus,
)
async def role_update_menus(
    db: AsyncSession,
    ctx: RunContext,
    role_id: str,
    grant_menu_ids: list[str] | None = None,
    revoke_menu_ids: list[str] | None = None,
) -> dict[str, Any]:
    role, new, added, removed, _, menus = await _menu_plan(db, role_id, grant_menu_ids or [], revoke_menu_ids or [])
    # 改角色菜单会清掉这个角色下所有人的用户缓存（权限码和侧边栏都在里面）—— service 里挂在 background_tasks 上
    await role_service.update_role_menu(
        db=db, background_tasks=ctx.background_tasks, pk=role.id, menu_ids=UpdateRoleMenuParam(menus=sorted(new))
    )
    return {
        'role_id': role_id,
        'added': [_menu_label(menus[i], menus) for i in sorted(added)],
        'removed': [_menu_label(menus[i], menus) for i in sorted(removed)],
    }
