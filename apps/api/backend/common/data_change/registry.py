"""数据变更审计的登记表（#260）：哪些表要记、每一列怎么记。

内置的五个对象（用户 / 部门 / 角色 / 菜单 + 三张关联表）在 `app/admin/data_change.py` 登记；插件在自己目录下放
`data_change.py`（参数配置就是这样），`load_data_change_extensions()` 扫描并 import。同通知类型 / Webhook 事件那套机制。

🔴 **每一列都必须归类**：普通（`fields`）· 引用（`refs`，存 ID 也存当时的名字）· 敏感（`secret`，只记「改过」）·
忽略（`ignore`）· 逻辑删除标记（`soft_delete`）。主键自动算忽略。漏归类一列、或者写了一个不存在的列，登记当场抛 ——
防的是「以后加了个 `api_token` 列，明文进了审计表」：默认当普通列记的话，这件事静默、而且是泄密。
"""

from __future__ import annotations

import importlib
import importlib.util
import pkgutil

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa

from backend.common.log import log

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping


@dataclass(frozen=True, slots=True)
class Ref:
    """引用另一张表：存 ID，也存提交那一刻对方的名字（对方后来改名 / 被删，记录照样看得懂）"""

    table: str
    label: str


@dataclass(slots=True)
class AuditedEntity:
    entity: str
    title: str
    table: sa.Table
    #: 拿哪几列当对象的名字；多列用「 · 」拼（通知策略一格一行：类型 · 渠道）
    label_columns: tuple[str, ...]
    #: 要记的列 → 中文名（普通 + 引用 + 敏感都在这里，顺序就是展示顺序）
    labels: dict[str, str]
    refs: dict[str, Ref] = field(default_factory=dict)
    #: 固定取值的列 → {值: 中文名}（状态、菜单类型…）
    enums: dict[str, dict[Any, str]] = field(default_factory=dict)
    secret: frozenset[str] = frozenset()
    #: 按行判断要不要当敏感列（参数配置的 `value`：键名是 `EMAIL_PASSWORD` 的那一行才是密码）
    secret_when: dict[str, Callable[[Mapping[str, Any]], bool]] = field(default_factory=dict)
    ignore: frozenset[str] = frozenset()
    soft_delete: str | None = None

    def label_of(self, row: Mapping[str, Any]) -> Any:
        """这个对象在记录里叫什么。单列照原样；多列拼起来 ——
        只用一列的话，同一个类型的两格策略在列表上分不开（#286 评审）"""
        if len(self.label_columns) == 1:
            return row[self.label_columns[0]]
        return ' · '.join(str(row[c]) for c in self.label_columns if row[c] is not None)

    def is_secret(self, column: str, row: Mapping[str, Any] | None) -> bool:
        if column in self.secret:
            return True
        predicate = self.secret_when.get(column)
        # 没有行（批量汇总）就按最坏情况算：宁可少记一个值，不能把密码写进审计表
        return predicate is not None and (row is None or predicate(row))

    @property
    def pk(self) -> sa.Column:
        (col,) = self.table.primary_key.columns
        return col


@dataclass(slots=True)
class AuditedSet:
    """关联表：折叠成父对象的一个「集合」字段（用户的角色、角色的菜单、用户绑的第三方账号…）"""

    table: sa.Table
    entity: str
    parent_column: str
    member_column: str
    field: str
    label: str
    ref: Ref | None = None
    #: 成员没有引用表、值本身是个代号时的显示名（第三方账号的 `Github` → GitHub）
    member_labels: dict[Any, str] | None = None
    #: 逻辑删除标记列：非 0 的行不算成员（第三方账号解绑是逻辑删除）
    active: str | None = None

    @property
    def watched(self) -> frozenset[str]:
        """写到这几列才可能改变成员集合"""
        return frozenset(c for c in (self.parent_column, self.member_column, self.active) if c)


@dataclass(frozen=True, slots=True)
class ChildValue:
    """一对一子表里折叠到父对象上的一个字段：从那一行算出来的值，两边都有这一行时才比"""

    label: str
    of: Callable[[Mapping[str, Any]], Any]
    #: 只记「改过」（恢复码：算出来的是哈希集合，哈希也不进审计表）
    secret: bool = False


@dataclass(slots=True)
class AuditedChild:
    """一对一子表：**有没有这一行**折叠成父对象的一个开关字段（用户的二次验证：开了才有这一行），
    行里的几列折叠成父对象的另几个字段（重新生成恢复码）。

    和关联表一样记到父对象名下 —— 单独当一个对象记的话，它的记录挂在子表自己的 ID 上，
    用户的「变更记录」里看不到「谁把他的二次验证关了」。
    """

    table: sa.Table
    entity: str
    parent_column: str
    field: str
    label: str
    #: (没有这一行时, 有这一行时) 的中文名
    states: tuple[str, str]
    values: dict[str, ChildValue]
    #: 只写这些列的语句不用抓（每次用动态码登录都写的 `last_step`）
    ignore: frozenset[str]

    @property
    def watched(self) -> frozenset[str]:
        return frozenset(c.name for c in self.table.columns) - self.ignore


#: entity → 登记
ENTITIES: dict[str, AuditedEntity] = {}
#: 表名 → 登记
_ENTITY_BY_TABLE: dict[str, AuditedEntity] = {}
#: 关联表表名 → 登记
SETS: dict[str, AuditedSet] = {}
#: 一对一子表表名 → 登记
CHILDREN: dict[str, AuditedChild] = {}
#: 拦截层每条语句都要判一次「这张表管不管」，单独留一份
AUDITED_TABLES: set[str] = set()

#: 来源 → 中文名。新增来源同时要进 `server-data-keys.json` 和两个语言包
SOURCES: dict[str, str] = {
    'web': '网页',
    'ai': 'AI 助手',
    'import': '批量导入',
    'oauth2': '第三方登录',
    'task': '定时任务',
    'system': '系统',
}

#: 动作 → 中文名
#: 动作 → 中文名。🔴 不能用「新建 / 修改 / 删除」：那三个 key 在语言包里是按钮上的动词（New / Edit / Delete），
#: 一个 key 只能有一个意思（i18n 分册），审计记录要的是过去式
ACTIONS: dict[str, str] = {'create': '已新建', 'update': '已修改', 'delete': '已删除', 'bulk': '已批量修改'}


def _table_of(model_or_table: Any) -> sa.Table:
    table = model_or_table if isinstance(model_or_table, sa.Table) else model_or_table.__table__
    if not isinstance(table, sa.Table):
        raise TypeError(f'{model_or_table!r} 不是一张表')
    return table


def _validate(
    table: sa.Table,
    groups: dict[str, set[str]],
    *,
    label: tuple[str, ...],
    enums: dict[str, Any],
    fields: dict[str, str],
) -> None:
    """每一列恰好归一类、写的列都存在、名字列和 enums 对得上"""
    seen: dict[str, str] = {}
    for group, names in groups.items():
        for name in names:
            if name in seen:
                raise ValueError(f'数据变更登记：{table.name}.{name} 同时出现在 {seen[name]} 和 {group}')
            seen[name] = group
    columns = {c.name for c in table.columns}
    pk_names = {c.name for c in table.primary_key.columns}
    unknown = set(seen) - columns
    if unknown:
        raise ValueError(f'数据变更登记：{table.name} 没有这些列：{sorted(unknown)}')
    unclassified = columns - set(seen) - pk_names
    if unclassified:
        raise ValueError(
            f'数据变更登记：{table.name} 有列没归类：{sorted(unclassified)}。'
            '每一列都要写进 fields / refs / secret / ignore 之一 —— 默认当普通列记的话，新加的敏感列会明文进审计表'
        )
    if len(pk_names) != 1:
        raise ValueError(f'数据变更登记：{table.name} 不是单列主键')
    missing = [name for name in label if name not in columns]
    if not label or missing:
        raise ValueError(f'数据变更登记：{table.name} 没有名字列 {missing or label!r}')
    bad_enums = set(enums) - set(fields)
    if bad_enums:
        raise ValueError(f'数据变更登记：{table.name} 的 enums 只能给 fields 里的列：{sorted(bad_enums)}')


def register_audited(
    model: Any,
    *,
    entity: str,
    title: str,
    label: str | tuple[str, ...],
    fields: dict[str, str],
    refs: dict[str, tuple[str, Ref]] | None = None,
    enums: dict[str, dict[Any, str]] | None = None,
    secret: dict[str, str] | None = None,
    secret_when: dict[str, Callable[[Mapping[str, Any]], bool]] | None = None,
    ignore: set[str] | frozenset[str] = frozenset(),
    soft_delete: str | None = None,
) -> AuditedEntity:
    """登记一个要记变更的对象。

    :param entity: 对象类型（存进 `sys_data_change.entity_type`，前端按它筛），小写字母 + 下划线
    :param title: 对象的中文名（「用户」）
    :param label: 拿哪一列当这个对象的名字（记录里显示「改了 zhangsan」）；给几列就用「 · 」拼起来
    :param fields: 普通列 → 中文名
    :param refs: 引用列 → (中文名, 指向哪张表的哪一列)
    :param enums: 固定取值的列 → {值: 中文名}，必须是 `fields` 里的列
    :param secret: 敏感列 → 中文名（只记「改过」，不记值）
    :param secret_when: 普通列 → 按行判断这一行的值是不是敏感的（参数配置：键名像密码的那几行）
    :param ignore: 不记的列（时间戳、冗余列…）
    :param soft_delete: 逻辑删除标记列（`deleted` 从 0 变成非 0 记成「删除」，而不是一条字段变化）
    """
    table = _table_of(model)
    refs = refs or {}
    enums = enums or {}
    secret = secret or {}
    secret_when = secret_when or {}
    if set(secret_when) - set(fields):
        raise ValueError(
            f'数据变更登记：{table.name} 的 secret_when 只能给 fields 里的列：{sorted(set(secret_when) - set(fields))}'
        )

    if not entity.replace('_', '').isalpha() or not entity.islower():
        raise ValueError(f'数据变更登记：entity {entity!r} 只能是小写字母和下划线')
    existing = ENTITIES.get(entity)
    if existing is not None and existing.table is not table:
        raise ValueError(f'数据变更登记：entity {entity!r} 已经登记过（{existing.table.name}）')

    label_columns = (label,) if isinstance(label, str) else tuple(label)
    _validate(
        table,
        {
            'fields': set(fields),
            'refs': set(refs),
            'secret': set(secret),
            'ignore': set(ignore),
            'soft_delete': {soft_delete} if soft_delete else set(),
        },
        label=label_columns,
        enums=enums,
        fields=fields,
    )

    labels: dict[str, str] = {}
    for column in table.columns:
        name = column.name
        if name in fields:
            labels[name] = fields[name]
        elif name in refs:
            labels[name] = refs[name][0]
        elif name in secret:
            labels[name] = secret[name]

    spec = AuditedEntity(
        entity=entity,
        title=title,
        table=table,
        label_columns=label_columns,
        labels=labels,
        refs={name: ref for name, (_, ref) in refs.items()},
        enums=enums,
        secret=frozenset(secret),
        secret_when=dict(secret_when),
        ignore=frozenset(ignore) | frozenset(c.name for c in table.primary_key.columns),
        soft_delete=soft_delete,
    )
    ENTITIES[entity] = spec
    _ENTITY_BY_TABLE[table.name] = spec
    AUDITED_TABLES.add(table.name)
    return spec


def _check_folded_table(table: sa.Table, *, kind: str, columns: dict[str, str | None]) -> None:
    names = {c.name for c in table.columns}
    for what, name in columns.items():
        if name is not None and name not in names:
            raise ValueError(f'数据变更登记：{kind} {table.name} 没有{what}列 {name!r}')
    if table.name in _ENTITY_BY_TABLE:
        raise ValueError(f'数据变更登记：{table.name} 已经当成对象登记过，不能再当{kind}')


def register_audited_set(
    model_or_table: Any,
    *,
    entity: str,
    parent: str,
    member: str,
    field: str,
    label: str,
    ref: Ref | None = None,
    member_labels: dict[Any, str] | None = None,
    active: str | None = None,
) -> AuditedSet:
    """登记一张关联表：它的增删折叠成 `entity` 那个对象的一个集合字段（「角色：加了 A、去掉了 B」）。

    🔴 关联表的写入方式是「全删再全插」（改用户角色、存权限矩阵），所以记的是**提交时的净变化**，
    不是一条条 INSERT / DELETE —— 不然每次保存都是「删了 5 个、又加了同样 5 个」。

    :param member_labels: 成员没有引用表时的显示名（`ref` 和它二选一）
    :param active: 逻辑删除标记列（非 0 = 不算成员）。解绑是 `UPDATE … SET deleted = id` 的那种表要给
    """
    table = _table_of(model_or_table)
    _check_folded_table(table, kind='关联表', columns={'父对象': parent, '成员': member, '逻辑删除标记': active})
    if ref is not None and member_labels:
        raise ValueError(f'数据变更登记：关联表 {table.name} 的 ref 和 member_labels 只能给一个')
    existing = SETS.get(table.name)
    if existing is not None and (existing.entity, existing.field) != (entity, field):
        raise ValueError(f'数据变更登记：关联表 {table.name} 已经登记过（{existing.entity}.{existing.field}）')
    spec = AuditedSet(
        table=table,
        entity=entity,
        parent_column=parent,
        member_column=member,
        field=field,
        label=label,
        ref=ref,
        member_labels=dict(member_labels) if member_labels else None,
        active=active,
    )
    SETS[table.name] = spec
    AUDITED_TABLES.add(table.name)
    return spec


def register_audited_child(
    model: Any,
    *,
    entity: str,
    parent: str,
    field: str,
    label: str,
    states: tuple[str, str],
    values: dict[str, ChildValue] | None = None,
    ignore: set[str] | frozenset[str] = frozenset(),
) -> AuditedChild:
    """登记一张一对一子表：「有没有这一行」记成 `entity` 那个对象的开关字段 `field`，
    `values` 里每一项从那一行算出一个值，两边都有这一行时比（「恢复码：已修改」）。

    🔴 子表的列**不进审计表**，进的只是 `values` 算出来的东西 —— 所以不像对象那样要求每一列归类：
    以后加的列不会被谁读到。`ignore` 只决定「写这几列的语句要不要抓」，读的列写进去会漏记，登记时挡着。
    """
    table = _table_of(model)
    _check_folded_table(table, kind='子表', columns={'父对象': parent})
    unknown = set(ignore) - {c.name for c in table.columns}
    if unknown:
        raise ValueError(f'数据变更登记：子表 {table.name} 没有这些列：{sorted(unknown)}')
    if parent in ignore:
        raise ValueError(f'数据变更登记：子表 {table.name} 的父对象列不能忽略')
    existing = CHILDREN.get(table.name)
    if existing is not None and (existing.entity, existing.field) != (entity, field):
        raise ValueError(f'数据变更登记：子表 {table.name} 已经登记过（{existing.entity}.{existing.field}）')
    spec = AuditedChild(
        table=table,
        entity=entity,
        parent_column=parent,
        field=field,
        label=label,
        states=states,
        values=dict(values or {}),
        ignore=frozenset(ignore),
    )
    CHILDREN[table.name] = spec
    AUDITED_TABLES.add(table.name)
    return spec


def entity_for_table(name: str) -> AuditedEntity | None:
    return _ENTITY_BY_TABLE.get(name)


def set_for_table(name: str) -> AuditedSet | None:
    return SETS.get(name)


def child_for_table(name: str) -> AuditedChild | None:
    return CHILDREN.get(name)


def sets_of(entity: str) -> list[AuditedSet]:
    return [s for s in SETS.values() if s.entity == entity]


def children_of(entity: str) -> list[AuditedChild]:
    return [c for c in CHILDREN.values() if c.entity == entity]


def folded_fields(entity: str) -> list[tuple[str, str]]:
    """关联表 / 子表折叠到这个对象上的字段（字段名, 中文名）"""
    out = [(s.field, s.label) for s in sets_of(entity)]
    for child in children_of(entity):
        out.append((child.field, child.label))
        out += [(name, v.label) for name, v in child.values.items()]
    return out


def _check_folded() -> None:
    for spec in [*SETS.values(), *CHILDREN.values()]:
        if spec.entity not in ENTITIES:
            raise ValueError(f'数据变更登记：{spec.table.name} 指向的对象 {spec.entity!r} 没有登记')
    for entity, owner in ENTITIES.items():
        seen = set(owner.labels)
        for name, _ in folded_fields(entity):
            if name in seen:
                raise ValueError(f'数据变更登记：{entity}.{name} 重名（普通列 / 关联表 / 子表的字段名不能撞）')
            seen.add(name)


_EXTENSION_MODULE = 'data_change'
_loaded = False


def load_data_change_extensions(*, force: bool = False) -> None:
    """内置对象 + 扫描插件的 `data_change.py`。幂等。

    🔴 拦截层第一次碰到写语句时就会调它 —— 不能只在路由里装：Celery worker 不 import 路由，
    那边改了登记过的表就会静默漏记（短信插件 / 通知类型都踩过同一个坑）。
    """
    global _loaded
    if _loaded and not force:
        return
    _loaded = True
    try:
        importlib.import_module('backend.app.admin.data_change')

        import backend.plugin as plugin_pkg

        for module in pkgutil.iter_modules(plugin_pkg.__path__):
            if not module.ispkg:
                continue
            name = f'backend.plugin.{module.name}.{_EXTENSION_MODULE}'
            if importlib.util.find_spec(name) is None:
                continue
            # 不吞异常：列没归类 / 重复登记就该当场炸
            importlib.import_module(name)
            log.info(f'数据变更审计加载登记：{name}')
        _check_folded()
    except BaseException:
        _loaded = False
        raise


def describe() -> list[dict[str, Any]]:
    """给前端的元数据：对象类型、字段中文名（筛选下拉 + 翻译用）"""
    load_data_change_extensions()
    out = []
    for spec in ENTITIES.values():
        fields = [{'field': name, 'label': label} for name, label in spec.labels.items()]
        fields += [{'field': name, 'label': label} for name, label in folded_fields(spec.entity)]
        out.append({'entity': spec.entity, 'title': spec.title, 'fields': fields})
    return out
