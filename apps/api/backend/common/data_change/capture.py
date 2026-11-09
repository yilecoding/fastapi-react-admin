"""数据变更审计的拦截层（#260）：在会话层统一抓，调用方一处不改。

为什么在会话层而不是在 service 里一处处写：五张表的写入有 30 多处、5 种写法，漏一处就是「这类修改没有记录」，
而且是**静默**的（Webhook 那 15 个 `emit` 是同一个风险）。挂在会话上，以后新加的写路径自动被记。

做法 —— 「第一次碰到时拍原样，提交时和现状比」：

- `do_orm_execute`：按条件 UPDATE / DELETE（crud-plus 的 `update_model_by_column`、逻辑删除）· 按主键批量 UPDATE ·
  Core 写关联表 · 语句写子表（`delete(UserMfa)`）。执行**之前**按同一个 WHERE 把要动的行查出来，
  这个事务里第一次碰到的才存原样
- `transient_to_pending`：`db.add()` 那一刻记下「谁、从哪来」
  （`add` 在 AI 工具那段 `with` 里，flush 可能到提交时才发生）
- 属性 `set`（登记过的模型的每个列属性）：改已加载对象（`role.status = 0`）的那一刻记下来源 —— 会话 `autoflush=False`，
  flush 往往发生在 AI 工具那段 `with` 外面的提交时
- `before_flush`：改已加载对象 / `session.delete()` 的原样**从库里查**（flush 之前库里还是旧值）。不用属性历史 ——
  没加载过的属性（`load_only` / 过期）历史是空的，会被当成「从空改成了现值」（评审抓到的）。
  ORM 写的关联表 / 子表（`db.add(UserSocial(...))`、`db.delete(mfa)`）也在这里按父对象拍原样 ——
  flush 发的语句**不经过** `do_orm_execute`
- `after_flush`：unit of work 的 INSERT，记成「新建」
- `before_commit`：🔴 **先 flush**，再按主键查现状、和原样比、批量查引用的名字，在**同一个事务里**写 `sys_data_change`
- `after_soft_rollback`：外层回滚就丢掉缓冲。保存点回滚不丢 —— 比的是「原样 vs 提交时的现状」，回滚掉的改动比不出差别

🔴 **保存点提交也会触发 `before_commit` / `after_commit`**（SQLAlchemy 2.0 `SessionTransaction._prepare_impl`：
`if self._parent is None or self.nested`）。AI 工具每调用一次就开一个保存点写自己的调用审计、部门导入每行一个保存点 ——
不跳过的话一个请求被拆成好几条记录，而保存点里那次写记录出的错会被调用方的 `except Exception` 吞掉、缓冲已经清了，
记录静默丢失（评审抓到的）。所以两个钩子都只认最外层的提交。

🔴 `before_commit` 里那句 `flush()` 不能省（PostgreSQL / SQL Server 都实测过）：提交时 SQLAlchemy 是**先**触发
`before_commit`、**再**做最后一次 flush。`db.add()` 之后没 flush 的新对象（角色 / 菜单 / 参数的 `create_model`），
`after_flush` 要等这里跑完才轮到 —— 不先 flush 的话这条新建漏记，而且它进了缓冲没人写，会记到下一个事务头上。

**拦不到的写法**（由 `test_data_change.py` 的静态守卫挡在生产代码外面，运行时不报错 —— 测试收尾大量用它们硬删数据）：
`text()` 原生 SQL · 语句式 `insert(User)`（拿不到新行的主键）· `session.connection().execute(...)`
（包括 crud-plus `bulk_update_models(pk_mode=False)`）。迁移、`fba init`、种子 SQL 走连接，不经过会话，不记，符合预期。
"""

from __future__ import annotations

import re

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal
from enum import Enum
from typing import TYPE_CHECKING, Any

import sqlalchemy as sa

from sqlalchemy import event
from sqlalchemy.orm import Session

from backend.common.data_change import registry

if TYPE_CHECKING:
    from collections.abc import Iterable, Iterator

    from sqlalchemy.orm import ORMExecuteState, SessionTransaction

#: 一条语句命中超过这么多行，只记一条「批量修改」汇总，不先把半张表查出来
BULK_LIMIT = 500
#: SQL Server 一条语句最多 2100 个参数，IN 列表分批
_IN_CHUNK = 500
_MAX_SAFE_INT = 2**53 - 1

_BUFFER = 'data_change_buffer'
_BUSY = 'data_change_busy'
#: 挂在 `InstanceState.info` 上：这个对象的属性第一次被改的那一刻是谁、从哪来
_ORIGIN = 'data_change_origin'
#: 折叠到父对象上的表：关联表（集合字段）/ 一对一子表（开关字段）
_Folded = registry.AuditedSet | registry.AuditedChild
#: 批量汇总行里列出的集合成员最多几个（「从 1234 个用户身上去掉了『访客』」只需要那一个角色）
_BULK_MEMBERS = 20

_source: ContextVar[tuple[str, str | None, int | None] | None] = ContextVar('data_change_source', default=None)


@contextmanager
def data_change_source(source: str, ref: str | None = None, *, actor_id: int | None = None) -> Iterator[None]:
    """这段代码里发生的修改记成别的来源（AI 助手 / 批量导入 / 第三方登录 / 定时任务）。

    来源在**第一次碰到那一行**时就定下来，所以提交发生在 `with` 外面也没关系。

    :param actor_id: 显式给操作人。🔴 AI 对话是流式响应，生成器跑起来时请求上下文（starlette-context）
        可能已经收尾了，从上下文里取会拿到空 —— 这类入口要自己传
    """
    if source not in registry.SOURCES:
        raise ValueError(f'数据变更来源 {source!r} 没有登记（registry.SOURCES）')
    token = _source.set((source, ref, actor_id))
    try:
        yield
    finally:
        _source.reset(token)


@dataclass(frozen=True, slots=True)
class Origin:
    actor_id: int | None
    source: str
    source_ref: str | None
    ip: str | None
    trace_id: str


def current_origin() -> Origin:
    from backend.common.context import ctx
    from backend.utils.trace_id import get_request_trace_id

    actor_id = ip = None
    if ctx.exists():
        actor_id = ctx.user_id
        ip = ctx.ip
    override = _source.get()
    if override is not None:
        source, ref, explicit_actor = override
        if explicit_actor is not None:
            actor_id = explicit_actor
    else:
        source, ref = ('web' if actor_id else 'system'), None
    return Origin(actor_id=actor_id, source=source, source_ref=ref, ip=ip, trace_id=get_request_trace_id())


@dataclass(slots=True)
class _Row:
    #: None = 这个事务里新建的
    original: dict[str, Any] | None
    origin: Origin


@dataclass(slots=True)
class _Buffer:
    rows: dict[tuple[str, Any], _Row] = field(default_factory=dict)
    #: (关联表 / 子表, 父 ID) → (第一次碰到时的快照, 来源)。
    #: 快照：关联表是成员集合，子表是那一行算出来的值（没有这一行是 None）
    sets: dict[tuple[str, Any], tuple[Any, Origin]] = field(default_factory=dict)
    bulk: list[dict[str, Any]] = field(default_factory=list)
    #: id(新对象) → `add()` 那一刻的来源
    pending: dict[int, Origin] = field(default_factory=dict)

    def empty(self) -> bool:
        return not (self.rows or self.sets or self.bulk)


def _buffer(session: Session) -> _Buffer:
    buf = session.info.get(_BUFFER)
    if buf is None:
        buf = session.info[_BUFFER] = _Buffer()
    return buf


@contextmanager
def _busy(session: Session) -> Iterator[None]:
    session.info[_BUSY] = True
    try:
        yield
    finally:
        session.info.pop(_BUSY, None)


def _fetch(session: Session, stmt: sa.Executable) -> list[Any]:
    with _busy(session):
        return list(session.execute(stmt).mappings().all())


def _chunks(values: list[Any]) -> Iterable[list[Any]]:
    for i in range(0, len(values), _IN_CHUNK):
        yield values[i : i + _IN_CHUNK]


# ── 抓 ────────────────────────────────────────────────────────────────────────


def _on_execute(st: ORMExecuteState) -> None:
    if not _ready:
        # 第一条语句（通常是 SELECT）就装好登记表和属性监听：改已加载对象之前，那个对象总得先被查出来
        _ensure()
    session = st.session
    if st.is_select or session.info.get(_BUSY):
        return
    stmt = st.statement
    if not getattr(stmt, 'is_dml', False):
        return
    name = getattr(getattr(stmt, 'table', None), 'name', None)
    if name is None:
        return
    _ensure()
    if name not in registry.AUDITED_TABLES:
        return
    spec = registry.entity_for_table(name)
    if spec is not None:
        _capture_entity(st, spec)
    else:
        folded = _folded_for_table(name)
        if folded is not None:
            _capture_folded(st, folded)


def _capture_entity(st: ORMExecuteState, spec: registry.AuditedEntity) -> None:
    if not (st.is_update or st.is_delete):
        # 语句式 INSERT 拿不到新行的主键；生产代码里由静态守卫挡着（见模块注释）
        return
    session = st.session
    table = spec.table
    pk = spec.pk
    params = st.parameters
    written = _written_columns(st)
    if st.is_update and written and written <= spec.ignore:
        # 只写忽略列（每次登录的 `update_login_time`）：比不出任何东西，不白查两次整行（评审抓到的）
        return
    origin = current_origin()
    buf = _buffer(session)
    if isinstance(params, list):
        # 按主键的批量 UPDATE（`bulk_update_models`）：主键在每组参数里。
        # 🔴 主键要分批放进 IN —— SQL Server 一条语句最多 2100 个参数，一次塞进去的话业务那条 UPDATE 跟着失败
        ids = [p[pk.key] for p in params if pk.key in p]
        if len(ids) > BULK_LIMIT:
            buf.bulk.append({
                'spec': spec,
                'count': len(ids),
                'varies': sorted(written - spec.ignore),
                'origin': origin,
            })
            return
        rows = [r for chunk in _chunks(ids) for r in _fetch(session, sa.select(table).where(pk.in_(chunk)))]
    else:
        where = st.statement.whereclause
        if where is None:
            where = sa.true()
        rows = _fetch(session, sa.select(table).where(where).limit(BULK_LIMIT + 1))
        if len(rows) > BULK_LIMIT:
            with _busy(session):
                count = session.execute(sa.select(sa.func.count()).select_from(table).where(where)).scalar_one()
            buf.bulk.append({'spec': spec, 'count': count, 'values': _literal_values(st), 'origin': origin})
            return
    for row in rows:
        key = (table.name, row[pk.name])
        if key not in buf.rows:
            buf.rows[key] = _Row(original=dict(row), origin=origin)


def _column_name(key: Any) -> str:
    return getattr(key, 'name', None) or getattr(key, 'key', None) or str(key)


def _written_columns(st: ORMExecuteState) -> set[str]:
    """这条 UPDATE 要写哪些列（`.values(...)` 里的 + executemany 每组参数里的）。拿不准时返回空集 = 不跳过"""
    names = {_column_name(k) for k in (getattr(st.statement, '_values', None) or {})}
    params = st.parameters
    for p in params if isinstance(params, list) else ([params] if params else []):
        names |= set(p)
    return names


def _literal_values(st: ORMExecuteState) -> dict[str, Any]:
    """批量汇总行要写「改成了什么」：只认语句里的字面量（`.values(status=0)`），表达式不认"""
    out: dict[str, Any] = {}
    for col, bind in (getattr(st.statement, '_values', None) or {}).items():
        name = _column_name(col)
        value = getattr(bind, 'value', None)
        if isinstance(bind, sa.sql.elements.BindParameter):
            out[name] = value
    return out


def _folded_for_table(name: str) -> _Folded | None:
    return registry.set_for_table(name) or registry.child_for_table(name)


def _capture_folded(st: ORMExecuteState, spec: _Folded) -> None:
    """语句写关联表 / 子表（Core 写 `sys_user_role`、`delete(UserMfa).where(...)`、逻辑删除解绑）：按父对象拍原样"""
    session = st.session
    table = spec.table
    parent = table.c[spec.parent_column]
    buf = _buffer(session)
    if st.is_delete or st.is_update:
        if st.is_update:
            written = _written_columns(st)
            if written and not (written & spec.watched):
                return
        where = st.statement.whereclause
        if where is None:
            where = sa.true()
        parents = {
            r[spec.parent_column]
            for r in _fetch(session, sa.select(parent).where(where).distinct().limit(BULK_LIMIT + 1))
        }
        if len(parents) > BULK_LIMIT:
            # 🔴 关联表也要有上限：从 2 万人身上摘掉一个角色，逐个父对象拍集合 + 写 2 万行记录，
            # 全在业务事务里（评审抓到的）。只记一条汇总：哪个集合字段、多少个对象、去掉了谁
            with _busy(session):
                count = session.execute(sa.select(sa.func.count(sa.distinct(parent))).where(where)).scalar_one()
            removed: list[Any] = []
            if isinstance(spec, registry.AuditedSet):
                member = table.c[spec.member_column]
                removed = [
                    r[spec.member_column]
                    for r in _fetch(session, sa.select(member).where(where).distinct().limit(_BULK_MEMBERS))
                ]
            buf.bulk.append({'folded': spec, 'count': count, 'removed': removed, 'origin': current_origin()})
            return
    elif st.is_insert:
        parents = set(_insert_values(st, spec.parent_column))
        if len(parents) > BULK_LIMIT:
            added: list[Any] = []
            if isinstance(spec, registry.AuditedSet):
                added = sorted(set(_insert_values(st, spec.member_column)), key=str)[:_BULK_MEMBERS]
            buf.bulk.append({'folded': spec, 'count': len(parents), 'added': added, 'origin': current_origin()})
            return
    else:
        return
    _remember(session, spec, dict.fromkeys(parents))


def _remember(session: Session, spec: _Folded, parents: dict[Any, Origin | None]) -> None:
    """这个事务里第一次碰到的父对象：拍一次原样（关联表的成员集合 / 子表那一行算出来的值）"""
    buf = _buffer(session)
    fresh = [p for p in parents if (spec.table.name, p) not in buf.sets]
    if not fresh:
        return
    before = _snapshot(session, spec, fresh)
    fallback: Origin | None = None
    for p in fresh:
        origin = parents[p]
        if origin is None:
            fallback = fallback or current_origin()
            origin = fallback
        buf.sets[spec.table.name, p] = (before[p], origin)


def _snapshot(session: Session, spec: _Folded, parents: list[Any]) -> dict[Any, Any]:
    table = spec.table
    p_col = table.c[spec.parent_column]
    if isinstance(spec, registry.AuditedSet):
        m_col = table.c[spec.member_column]
        members: dict[Any, set[Any]] = {p: set() for p in parents}
        for chunk in _chunks(parents):
            stmt = sa.select(p_col, m_col).where(p_col.in_(chunk))
            if spec.active:
                stmt = stmt.where(table.c[spec.active] == 0)
            for r in _fetch(session, stmt):
                members[r[spec.parent_column]].add(r[spec.member_column])
        return {p: frozenset(m) for p, m in members.items()}
    rows: dict[Any, Any] = dict.fromkeys(parents)
    for chunk in _chunks(parents):
        for r in _fetch(session, sa.select(table).where(p_col.in_(chunk))):
            # 只留算出来的值：子表那一行（二次验证的密钥密文）不在内存里多待
            rows[r[spec.parent_column]] = {name: v.of(r) for name, v in spec.values.items()}
    return rows


def _insert_values(st: ORMExecuteState, column: str) -> list[Any]:
    params = st.parameters
    rows = params if isinstance(params, list) else ([params] if params else [])
    values = [r[column] for r in rows if column in r]
    if values:
        return values
    # `insert(t).values(user_id=…, role_id=…)`：值在语句里，不在参数里（多行 values 编译成 user_id_m0 / _m1…）
    compiled = st.statement.compile()
    pattern = re.compile(rf'{re.escape(column)}(_m\d+)?')
    return [v for k, v in compiled.params.items() if pattern.fullmatch(k)]


def _spec_of(obj: Any) -> registry.AuditedEntity | None:
    table = getattr(type(obj), '__table__', None)
    if table is None:
        return None
    _ensure()
    return registry.entity_for_table(table.name)


def _folded_of(obj: Any) -> _Folded | None:
    table = getattr(type(obj), '__table__', None)
    if table is None:
        return None
    _ensure()
    return _folded_for_table(table.name)


def _on_pending(session: Session, instance: Any) -> None:
    if session.info.get(_BUSY) or (_spec_of(instance) is None and _folded_of(instance) is None):
        return
    _buffer(session).pending[id(instance)] = current_origin()


def _on_attr_set(target: Any, value: Any, _old: Any, _initiator: Any) -> Any:
    """改已加载对象的属性：第一次改的那一刻记下来源（flush 可能要到 `with data_change_source` 外面的提交时）"""
    state = sa.inspect(target)
    if state.persistent and _ORIGIN not in state.info:
        state.info[_ORIGIN] = current_origin()
    return value


def _on_before_flush(session: Session, _flush_context: Any, _instances: Any) -> None:
    """改已加载对象 / `session.delete()`：原样**从库里查**（flush 之前库里还是旧值）。

    不用属性历史：没加载过的属性（`load_only` / 过期）历史是空的，拍出来是 None，
    提交时就成了「从空改成了现值」—— 每个没加载的列都记一条假变更（评审抓到的）
    """
    if session.info.get(_BUSY):
        return
    _remember_flushed(session)
    touched = [o for o in session.dirty if session.is_modified(o, include_collections=False)] + list(session.deleted)
    wanted: dict[str, list[tuple[Any, Any, Origin]]] = {}
    buf: _Buffer | None = None
    for obj in touched:
        spec = _spec_of(obj)
        if spec is None:
            continue
        buf = buf or _buffer(session)
        pk = getattr(obj, spec.pk.key)
        state = sa.inspect(obj)
        origin = state.info.pop(_ORIGIN, None) or current_origin()
        if (spec.table.name, pk) not in buf.rows:
            wanted.setdefault(spec.table.name, []).append((pk, obj, origin))
    for table_name, items in wanted.items():
        spec = registry.entity_for_table(table_name)
        assert spec is not None and buf is not None
        before = _current_rows(session, spec, [pk for pk, _, _ in items])
        for pk, _obj, origin in items:
            if pk in before:
                buf.rows[table_name, pk] = _Row(original=before[pk], origin=origin)


def _changed_columns(state: Any) -> set[str]:
    out: set[str] = set()
    for attr in state.attrs:
        if attr.history.has_changes():
            out.update(c.name for c in getattr(state.mapper.get_property(attr.key), 'columns', ()))
    return out


def _remember_flushed(session: Session) -> None:
    """ORM 写的关联表 / 子表（`db.add(UserSocial(...))`、`db.delete(mfa)`、改 `mfa.recovery_hashes`）：
    这些语句是 flush 发的，不经过 `do_orm_execute` —— 在 flush 之前按父对象拍原样"""
    wanted: dict[str, dict[Any, Origin | None]] = {}
    dirty = session.dirty
    for obj in [*session.new, *dirty, *session.deleted]:
        spec = _folded_of(obj)
        if spec is None:
            continue
        state = sa.inspect(obj)
        origin = state.info.pop(_ORIGIN, None)
        if obj in dirty and not (_changed_columns(state) & spec.watched):
            # 只改了忽略列（每次用动态码登录都写的 `last_step`）
            continue
        origin = _buffer(session).pending.pop(id(obj), None) or origin
        key = state.mapper.get_property_by_column(spec.table.c[spec.parent_column]).key
        wanted.setdefault(spec.table.name, {}).setdefault(getattr(obj, key), origin)
    for table_name, parents in wanted.items():
        spec = _folded_for_table(table_name)
        assert spec is not None
        _remember(session, spec, parents)


def _on_after_flush(session: Session, _flush_context: Any) -> None:
    if session.info.get(_BUSY):
        return
    for obj in session.new:
        spec = _spec_of(obj)
        if spec is None:
            continue
        buf = _buffer(session)
        added_at = buf.pending.pop(id(obj), None)
        key = (spec.table.name, getattr(obj, spec.pk.key))
        if key not in buf.rows:
            buf.rows[key] = _Row(original=None, origin=added_at or current_origin())


def _on_rollback(session: Session, previous_transaction: SessionTransaction) -> None:
    if not previous_transaction.nested:
        session.info.pop(_BUFFER, None)


def _on_after_commit(session: Session) -> None:
    # 保存点提交也会走到这里（见模块注释）：那时清缓冲 = 丢掉保存点之前抓到的改动
    if not session.in_nested_transaction():
        session.info.pop(_BUFFER, None)


# ── 比 + 写 ──────────────────────────────────────────────────────────────────


def _on_before_commit(session: Session) -> None:
    # 🔴 只认最外层的提交：保存点提交也会触发 before_commit（见模块注释）
    if session.info.get(_BUSY) or session.in_nested_transaction():
        return
    # 🔴 先 flush：见模块注释。没东西要 flush 时是空操作
    session.flush()
    buf: _Buffer | None = session.info.get(_BUFFER)
    if buf is None or buf.empty():
        return
    try:
        records = _build_records(session, buf)
        if records:
            _write(session, records)
    finally:
        session.info.pop(_BUFFER, None)


def plain(value: Any) -> Any:
    """存进 JSON 的值：雪花 ID 一律字符串（硬纪律 6），时间带时区标记"""
    if value is None or isinstance(value, (bool, str, float)):
        return value
    if isinstance(value, int):
        return str(value) if abs(value) > _MAX_SAFE_INT else value
    if isinstance(value, datetime):
        from backend.utils.timezone import timezone

        return timezone.to_iso(value) if value.tzinfo is not None else value.isoformat()
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, Enum):
        return plain(value.value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return None
    return str(value)


@dataclass(slots=True)
class _Record:
    spec: registry.AuditedEntity
    entity_id: Any
    action: str
    origin: Origin
    label: Any = None
    changes: list[dict[str, Any]] = field(default_factory=list)


def _current_rows(session: Session, spec: registry.AuditedEntity, ids: list[Any]) -> dict[Any, dict[str, Any]]:
    out: dict[Any, dict[str, Any]] = {}
    for chunk in _chunks(ids):
        for r in _fetch(session, sa.select(spec.table).where(spec.pk.in_(chunk))):
            out[r[spec.pk.name]] = dict(r)
    return out


def _value_change(
    spec: registry.AuditedEntity, column: str, old: Any, new: Any, *, created: bool, row: dict[str, Any] | None
) -> dict[str, Any]:
    item: dict[str, Any] = {'field': column, 'label': spec.labels[column]}
    if spec.is_secret(column, row):
        item['secret'] = True
        return item
    if not created:
        item['old'] = plain(old)
    item['new'] = plain(new)
    enum = spec.enums.get(column)
    if enum is not None:
        if not created and old in enum:
            item['old_label'] = enum[old]
        if new in enum:
            item['new_label'] = enum[new]
    return item


def _is_deleted(spec: registry.AuditedEntity, row: dict[str, Any]) -> bool:
    return bool(spec.soft_delete and row.get(spec.soft_delete))


def _build_records(session: Session, buf: _Buffer) -> list[_Record]:
    records: dict[tuple[str, Any], _Record] = {}

    by_table: dict[str, list[Any]] = {}
    for table_name, pk in buf.rows:
        by_table.setdefault(table_name, []).append(pk)
    current: dict[str, dict[Any, dict[str, Any]]] = {}
    for table_name, ids in by_table.items():
        spec = registry.entity_for_table(table_name)
        assert spec is not None
        current[table_name] = _current_rows(session, spec, ids)

    for (table_name, pk), row in buf.rows.items():
        spec = registry.entity_for_table(table_name)
        assert spec is not None
        cur = current[table_name].get(pk)
        orig = row.original
        if orig is None:
            if cur is None or _is_deleted(spec, cur):
                continue  # 同一个事务里建了又删了
            changes = [
                _value_change(spec, col, None, cur[col], created=True, row=cur)
                for col in spec.labels
                if cur.get(col) is not None
            ]
            records[spec.entity, pk] = _Record(spec, pk, 'create', row.origin, cur[spec.label_column], changes)
        elif cur is None or (_is_deleted(spec, cur) and not _is_deleted(spec, orig)):
            records[spec.entity, pk] = _Record(spec, pk, 'delete', row.origin, orig[spec.label_column])
        else:
            # 敏感与否按改前改后两行都看：键名改了的那一行，只要有一边像密码就不记值
            changes = [
                _value_change(
                    spec,
                    col,
                    orig.get(col),
                    cur.get(col),
                    created=False,
                    row=cur if spec.is_secret(col, cur) or not spec.is_secret(col, orig) else orig,
                )
                for col in spec.labels
                if orig.get(col) != cur.get(col)
            ]
            if changes:
                records[spec.entity, pk] = _Record(spec, pk, 'update', row.origin, cur[spec.label_column], changes)

    _merge_sets(session, buf, records)
    out = list(records.values())
    out += [_bulk_record(b) for b in buf.bulk]
    _resolve_labels(session, out)
    return out


def _current_folded(session: Session, buf: _Buffer) -> dict[tuple[str, Any], Any]:
    by_table: dict[str, list[Any]] = {}
    for table_name, parent in buf.sets:
        by_table.setdefault(table_name, []).append(parent)
    after: dict[tuple[str, Any], Any] = {}
    for table_name, parents in by_table.items():
        spec = _folded_for_table(table_name)
        assert spec is not None
        for parent, value in _snapshot(session, spec, parents).items():
            after[table_name, parent] = value
    return after


def _folded_changes(spec: _Folded, before: Any, now: Any) -> list[dict[str, Any]]:
    if isinstance(spec, registry.AuditedSet):
        added, removed = now - before, before - now
        if not added and not removed:
            return []
        return [
            {
                'field': spec.field,
                'label': spec.label,
                'added': [plain(m) for m in sorted(added, key=str)],
                'removed': [plain(m) for m in sorted(removed, key=str)],
            }
        ]
    if (before is None) != (now is None):
        # 有没有这一行就是开关本身（开了二次验证才有）；行里的值在这时不另记 —— 「开启时生成了恢复码」是废话
        old, new = before is not None, now is not None
        return [
            {
                'field': spec.field,
                'label': spec.label,
                'old': old,
                'new': new,
                'old_label': spec.states[int(old)],
                'new_label': spec.states[int(new)],
            }
        ]
    if before is None or now is None:
        return []
    out: list[dict[str, Any]] = []
    for name, value in spec.values.items():
        if before[name] == now[name]:
            continue
        item: dict[str, Any] = {'field': name, 'label': value.label}
        if value.secret:
            item['secret'] = True
        else:
            item['old'], item['new'] = plain(before[name]), plain(now[name])
        out.append(item)
    return out


def _parent_labels(session: Session, missing: dict[str, set[Any]]) -> dict[tuple[str, Any], Any]:
    """只有集合变了、对象本身没变的父对象：查一下它现在叫什么（已删除的不要）"""
    labels: dict[tuple[str, Any], Any] = {}
    for entity, ids in missing.items():
        spec = registry.ENTITIES[entity]
        for pk, row in _current_rows(session, spec, list(ids)).items():
            if not _is_deleted(spec, row):
                labels[entity, pk] = row[spec.label_column]
    return labels


def _merge_sets(session: Session, buf: _Buffer, records: dict[tuple[str, Any], _Record]) -> None:
    if not buf.sets:
        return
    after = _current_folded(session, buf)
    pending: list[tuple[_Folded, Any, list[dict[str, Any]], Origin]] = []
    missing: dict[str, set[Any]] = {}
    for (table_name, parent), (before, origin) in buf.sets.items():
        spec = _folded_for_table(table_name)
        assert spec is not None
        changes = _folded_changes(spec, before, after[table_name, parent])
        if not changes:
            continue
        pending.append((spec, parent, changes, origin))
        if (spec.entity, parent) not in records:
            missing.setdefault(spec.entity, set()).add(parent)
    labels = _parent_labels(session, missing)
    for spec, parent, changes, origin in pending:
        key = (spec.entity, parent)
        record = records.get(key)
        if record is None and key in labels:
            record = records[key] = _Record(registry.ENTITIES[spec.entity], parent, 'update', origin, labels[key])
        # 父对象没了（删用户时顺手清的关联）/ 这个事务里它被删了：只记「删除」
        if record is not None and record.action != 'delete':
            record.changes.extend(changes)


def _bulk_record(bulk: dict[str, Any]) -> _Record:
    """一条语句命中太多行：只记「哪类对象、多少个、改成了什么」。`entity_label` 存命中的个数（前端按 action=bulk 认）"""
    folded: _Folded | None = bulk.get('folded')
    if folded is not None:
        spec = registry.ENTITIES[folded.entity]
        change: dict[str, Any] = {'field': folded.field, 'label': folded.label}
        if isinstance(folded, registry.AuditedSet):
            change['added'] = [plain(m) for m in bulk.get('added', [])]
            change['removed'] = [plain(m) for m in bulk.get('removed', [])]
        else:
            change['varies'] = True
        return _Record(spec, None, 'bulk', bulk['origin'], str(bulk['count']), [change])
    spec = bulk['spec']
    changes = [
        _value_change(spec, col, None, value, created=True, row=None)
        for col, value in bulk.get('values', {}).items()
        if col in spec.labels
    ]
    # 按主键的批量 UPDATE：每一行的值不一样，只说改了哪些列
    changes += [
        {'field': col, 'label': spec.labels[col], 'varies': True}
        for col in bulk.get('varies', [])
        if col in spec.labels
    ]
    return _Record(spec, None, 'bulk', bulk['origin'], str(bulk['count']), changes)


#: (变化, 引用表, 'set' / 'value', 没有引用表时成员的显示名)
_Pending = list[tuple[dict[str, Any], 'registry.Ref | None', str, 'dict[Any, str] | None']]


def _collect_refs(records: list[_Record]) -> tuple[dict[registry.Ref, set[Any]], _Pending]:
    wanted: dict[registry.Ref, set[Any]] = {}
    pending: _Pending = []
    for record in records:
        for change in record.changes:
            if 'added' in change:
                set_spec = next(s for s in registry.sets_of(record.spec.entity) if s.field == change['field'])
                ref = set_spec.ref
                values = [*change['added'], *change['removed']]
                pending.append((change, ref, 'set', set_spec.member_labels))
            elif change['field'] in record.spec.refs:
                ref = record.spec.refs[change['field']]
                values = [change.get('old'), change.get('new')]
                pending.append((change, ref, 'value', None))
            else:
                continue
            if ref is not None:
                wanted.setdefault(ref, set()).update(v for v in values if v is not None)
    return wanted, pending


def _lookup_names(session: Session, wanted: dict[registry.Ref, set[Any]]) -> dict[registry.Ref, dict[str, Any]]:
    names: dict[registry.Ref, dict[str, Any]] = {}
    for ref, ids in wanted.items():
        target = sa.Table(ref.table, sa.MetaData(), sa.Column('id'), sa.Column(ref.label))
        found: dict[str, Any] = {}
        for chunk in _chunks([int(i) for i in ids]):
            for r in _fetch(session, sa.select(target.c.id, target.c[ref.label]).where(target.c.id.in_(chunk))):
                found[str(r['id'])] = r[ref.label]
        names[ref] = found
    return names


def _resolve_labels(session: Session, records: list[_Record]) -> None:
    """引用列和集合成员：一次查出提交那一刻对方叫什么（对方后来改名 / 被删，记录照样看得懂）"""
    wanted, pending = _collect_refs(records)
    names = _lookup_names(session, wanted)
    for change, ref, kind, member_labels in pending:
        found = names.get(ref, {}) if ref is not None else {str(k): v for k, v in (member_labels or {}).items()}
        if kind == 'set':
            for side in ('added', 'removed'):
                change[side] = [{'id': m, 'label': found.get(str(m))} for m in change[side]]
            continue
        for side in ('old', 'new'):
            value = change.get(side)
            if value is not None and str(value) in found:
                change[f'{side}_label'] = found[str(value)]


def _write(session: Session, records: list[_Record]) -> None:
    from backend.common.model import MappedBase
    from backend.utils.timezone import timezone

    table = MappedBase.metadata.tables['sys_data_change']
    actor_ids = sorted({r.origin.actor_id for r in records if r.origin.actor_id is not None})
    actors: dict[Any, str] = {}
    if actor_ids:
        user_table = registry.ENTITIES['user'].table if 'user' in registry.ENTITIES else None
        if user_table is not None:
            for r in _fetch(
                session, sa.select(user_table.c.id, user_table.c.username).where(user_table.c.id.in_(actor_ids))
            ):
                actors[r['id']] = r['username']
    now = timezone.now()
    rows = []
    for r in records:
        fields = sorted({c['field'] for c in r.changes})
        rows.append({
            'trace_id': r.origin.trace_id[:64],
            'entity_type': r.spec.entity,
            'entity_id': r.entity_id,
            'entity_label': None if r.label is None else str(r.label)[:256],
            'action': r.action,
            'changes': r.changes,
            'fields': (',' + ','.join(fields) + ',')[:1024] if fields else '',
            'actor_id': r.origin.actor_id,
            'actor_name': actors.get(r.origin.actor_id),
            'source': r.origin.source,
            'source_ref': None if r.origin.source_ref is None else r.origin.source_ref[:128],
            'ip': r.origin.ip,
            'created_time': now,
        })
    with _busy(session):
        session.execute(sa.insert(table), rows)


_instrumented: set[str] = set()
_ready = False


def _ensure() -> None:
    """装登记表（幂等），再给登记过的模型的列属性挂 `set` 监听（改已加载对象时记来源）"""
    global _ready
    registry.load_data_change_extensions()
    _ready = True
    if len(_instrumented) == len(registry.AUDITED_TABLES):
        return
    from backend.common.model import MappedBase

    tables = [s.table for s in (*registry.ENTITIES.values(), *registry.SETS.values(), *registry.CHILDREN.values())]
    for table in tables:
        if table.name in _instrumented:
            continue
        # 关联表多数是 Core 表（`sys_user_role`），没有映射类，跳过；第三方账号 / 二次验证是映射类
        for mapper in MappedBase.registry.mappers:
            if mapper.local_table is table:
                for prop in mapper.column_attrs:
                    event.listen(getattr(mapper.class_, prop.key), 'set', _on_attr_set, retval=True)
        _instrumented.add(table.name)


_installed = False


def install_data_change_capture() -> None:
    """挂到 `Session` 类上（所有会话，含 AsyncSession 里那个同步会话）。幂等"""
    global _installed
    if _installed:
        return
    event.listen(Session, 'do_orm_execute', _on_execute)
    event.listen(Session, 'transient_to_pending', _on_pending)
    event.listen(Session, 'before_flush', _on_before_flush)
    event.listen(Session, 'after_flush', _on_after_flush)
    event.listen(Session, 'before_commit', _on_before_commit)
    event.listen(Session, 'after_soft_rollback', _on_rollback)
    event.listen(Session, 'after_commit', _on_after_commit)
    _installed = True
