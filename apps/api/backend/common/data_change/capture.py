"""数据变更审计的拦截层（#260）：在会话层统一抓，调用方一处不改。

为什么在会话层而不是在 service 里一处处写：五张表的写入有 30 多处、5 种写法，漏一处就是「这类修改没有记录」，
而且是**静默**的（Webhook 那 15 个 `emit` 是同一个风险）。挂在会话上，以后新加的写路径自动被记。

做法 —— 「第一次碰到时拍原样，提交时和现状比」：

- `do_orm_execute`：按条件 UPDATE / DELETE（crud-plus 的 `update_model_by_column`、逻辑删除）· 按主键批量 UPDATE ·
  Core 写关联表。执行**之前**按同一个 WHERE 把要动的行查出来，这个事务里第一次碰到的才存原样
- `transient_to_pending`：`db.add()` 那一刻记下「谁、从哪来」
  （`add` 在 AI 工具那段 `with` 里，flush 可能到提交时才发生）
- `after_flush`：unit of work 的 INSERT / UPDATE / DELETE。新建的记成「新建」；改已加载对象的用属性历史拿原值
- `before_commit`：🔴 **先 flush**，再按主键查现状、和原样比、批量查引用的名字，在**同一个事务里**写 `sys_data_change`
- `after_soft_rollback`：外层回滚就丢掉缓冲。保存点回滚不丢 —— 比的是「原样 vs 提交时的现状」，回滚掉的改动比不出差别

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
    #: (关联表, 父 ID) → (第一次碰到时的成员集合, 来源)
    sets: dict[tuple[str, Any], tuple[frozenset[Any], Origin]] = field(default_factory=dict)
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
    session = st.session
    if st.is_select or session.info.get(_BUSY):
        return
    stmt = st.statement
    if not getattr(stmt, 'is_dml', False):
        return
    name = getattr(getattr(stmt, 'table', None), 'name', None)
    if name is None:
        return
    registry.load_data_change_extensions()
    if name not in registry.AUDITED_TABLES:
        return
    spec = registry.entity_for_table(name)
    if spec is not None:
        _capture_entity(st, spec)
    else:
        set_spec = registry.set_for_table(name)
        if set_spec is not None:
            _capture_set(st, set_spec)


def _capture_entity(st: ORMExecuteState, spec: registry.AuditedEntity) -> None:
    if not (st.is_update or st.is_delete):
        # 语句式 INSERT 拿不到新行的主键；生产代码里由静态守卫挡着（见模块注释）
        return
    session = st.session
    table = spec.table
    pk = spec.pk
    params = st.parameters
    if isinstance(params, list):
        # 按主键的批量 UPDATE（`bulk_update_models`）：主键在每组参数里
        where = pk.in_([p[pk.key] for p in params if pk.key in p])
    else:
        where = st.statement.whereclause
        if where is None:
            where = sa.true()
    rows = _fetch(session, sa.select(table).where(where).limit(BULK_LIMIT + 1))
    origin = current_origin()
    buf = _buffer(session)
    if len(rows) > BULK_LIMIT:
        with _busy(session):
            count = session.execute(sa.select(sa.func.count()).select_from(table).where(where)).scalar_one()
        buf.bulk.append({'spec': spec, 'count': count, 'values': _literal_values(st), 'origin': origin})
        return
    for row in rows:
        key = (table.name, row[pk.name])
        if key not in buf.rows:
            buf.rows[key] = _Row(original=dict(row), origin=origin)


def _literal_values(st: ORMExecuteState) -> dict[str, Any]:
    """批量汇总行要写「改成了什么」：只认语句里的字面量（`.values(status=0)`），表达式不认"""
    out: dict[str, Any] = {}
    for col, bind in (getattr(st.statement, '_values', None) or {}).items():
        name = getattr(col, 'name', None) or getattr(col, 'key', None) or str(col)
        value = getattr(bind, 'value', None)
        if isinstance(bind, sa.sql.elements.BindParameter):
            out[name] = value
    return out


def _capture_set(st: ORMExecuteState, spec: registry.AuditedSet) -> None:
    session = st.session
    table = spec.table
    parent = table.c[spec.parent_column]
    if st.is_delete:
        where = st.statement.whereclause
        if where is None:
            where = sa.true()
        parents = {r[spec.parent_column] for r in _fetch(session, sa.select(parent).where(where).distinct())}
    elif st.is_insert:
        parents = set(_insert_values(st, spec.parent_column))
    else:
        return
    buf = _buffer(session)
    fresh = [p for p in parents if (table.name, p) not in buf.sets]
    if not fresh:
        return
    origin = current_origin()
    members: dict[Any, set[Any]] = {p: set() for p in fresh}
    member = table.c[spec.member_column]
    for chunk in _chunks(fresh):
        for r in _fetch(session, sa.select(parent, member).where(parent.in_(chunk))):
            members[r[spec.parent_column]].add(r[spec.member_column])
    for p in fresh:
        buf.sets[table.name, p] = (frozenset(members[p]), origin)


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
    registry.load_data_change_extensions()
    return registry.entity_for_table(table.name)


def _on_pending(session: Session, instance: Any) -> None:
    if session.info.get(_BUSY) or _spec_of(instance) is None:
        return
    _buffer(session).pending[id(instance)] = current_origin()


def _object_values(obj: Any, spec: registry.AuditedEntity, *, original: bool) -> dict[str, Any]:
    """改已加载对象（unit of work）：用属性历史拿改之前的值"""
    state = sa.inspect(obj)
    out: dict[str, Any] = {}
    for col in spec.table.columns:
        prop = state.mapper.get_property_by_column(col)
        hist = state.attrs[prop.key].history
        if original and hist.deleted:
            out[col.name] = hist.deleted[0]
        elif hist.unchanged:
            out[col.name] = hist.unchanged[0]
        elif hist.added:
            out[col.name] = hist.added[0]
        else:
            out[col.name] = None
    return out


def _track(session: Session, obj: Any, *, created: bool) -> None:
    spec = _spec_of(obj)
    if spec is None:
        return
    buf = _buffer(session)
    added_at = buf.pending.pop(id(obj), None)
    key = (spec.table.name, getattr(obj, spec.pk.key))
    if key in buf.rows:
        return
    original = None if created else _object_values(obj, spec, original=True)
    buf.rows[key] = _Row(original=original, origin=added_at or current_origin())


def _on_after_flush(session: Session, _flush_context: Any) -> None:
    if session.info.get(_BUSY):
        return
    for obj in session.new:
        _track(session, obj, created=True)
    for obj in session.dirty:
        if session.is_modified(obj, include_collections=False):
            _track(session, obj, created=False)
    for obj in session.deleted:
        _track(session, obj, created=False)


def _on_rollback(session: Session, previous_transaction: SessionTransaction) -> None:
    if not previous_transaction.nested:
        session.info.pop(_BUFFER, None)


def _on_after_commit(session: Session) -> None:
    session.info.pop(_BUFFER, None)


# ── 比 + 写 ──────────────────────────────────────────────────────────────────


def _on_before_commit(session: Session) -> None:
    if session.info.get(_BUSY):
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


def _value_change(spec: registry.AuditedEntity, column: str, old: Any, new: Any, *, created: bool) -> dict[str, Any]:
    item: dict[str, Any] = {'field': column, 'label': spec.labels[column]}
    if column in spec.secret:
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
                _value_change(spec, col, None, cur[col], created=True)
                for col in spec.labels
                if cur.get(col) is not None
            ]
            records[spec.entity, pk] = _Record(spec, pk, 'create', row.origin, cur[spec.label_column], changes)
        elif cur is None or (_is_deleted(spec, cur) and not _is_deleted(spec, orig)):
            records[spec.entity, pk] = _Record(spec, pk, 'delete', row.origin, orig[spec.label_column])
        else:
            changes = [
                _value_change(spec, col, orig.get(col), cur.get(col), created=False)
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


def _current_sets(session: Session, buf: _Buffer) -> dict[tuple[str, Any], set[Any]]:
    by_table: dict[str, list[Any]] = {}
    for table_name, parent in buf.sets:
        by_table.setdefault(table_name, []).append(parent)
    after: dict[tuple[str, Any], set[Any]] = {key: set() for key in buf.sets}
    for table_name, parents in by_table.items():
        spec = registry.set_for_table(table_name)
        assert spec is not None
        p_col, m_col = spec.table.c[spec.parent_column], spec.table.c[spec.member_column]
        for chunk in _chunks(parents):
            for r in _fetch(session, sa.select(p_col, m_col).where(p_col.in_(chunk))):
                after[table_name, r[spec.parent_column]].add(r[spec.member_column])
    return after


def _set_change(spec: registry.AuditedSet, before: frozenset[Any], now: set[Any]) -> dict[str, Any] | None:
    added, removed = now - before, before - now
    if not added and not removed:
        return None
    return {
        'field': spec.field,
        'label': spec.label,
        'added': [plain(m) for m in sorted(added, key=str)],
        'removed': [plain(m) for m in sorted(removed, key=str)],
    }


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
    after = _current_sets(session, buf)
    pending: list[tuple[registry.AuditedSet, Any, dict[str, Any], Origin]] = []
    missing: dict[str, set[Any]] = {}
    for (table_name, parent), (before, origin) in buf.sets.items():
        spec = registry.set_for_table(table_name)
        assert spec is not None
        change = _set_change(spec, before, after[table_name, parent])
        if change is None:
            continue
        pending.append((spec, parent, change, origin))
        if (spec.entity, parent) not in records:
            missing.setdefault(spec.entity, set()).add(parent)
    labels = _parent_labels(session, missing)
    for spec, parent, change, origin in pending:
        key = (spec.entity, parent)
        record = records.get(key)
        if record is None and key in labels:
            record = records[key] = _Record(registry.ENTITIES[spec.entity], parent, 'update', origin, labels[key])
        # 父对象没了（删用户时顺手清的关联）/ 这个事务里它被删了：只记「删除」
        if record is not None and record.action != 'delete':
            record.changes.append(change)


def _bulk_record(bulk: dict[str, Any]) -> _Record:
    """一条语句命中太多行：只记「哪类对象、多少行、改成了什么」。`entity_label` 存命中行数（前端按 action=bulk 认）"""
    spec: registry.AuditedEntity = bulk['spec']
    changes = [
        _value_change(spec, col, None, value, created=True)
        for col, value in bulk['values'].items()
        if col in spec.labels
    ]
    return _Record(spec, None, 'bulk', bulk['origin'], str(bulk['count']), changes)


_Pending = list[tuple[dict[str, Any], 'registry.Ref | None', str]]


def _collect_refs(records: list[_Record]) -> tuple[dict[registry.Ref, set[Any]], _Pending]:
    wanted: dict[registry.Ref, set[Any]] = {}
    pending: _Pending = []
    for record in records:
        for change in record.changes:
            if 'added' in change:
                ref = next(s.ref for s in registry.sets_of(record.spec.entity) if s.field == change['field'])
                values = [*change['added'], *change['removed']]
                pending.append((change, ref, 'set'))
            elif change['field'] in record.spec.refs:
                ref = record.spec.refs[change['field']]
                values = [change.get('old'), change.get('new')]
                pending.append((change, ref, 'value'))
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
    for change, ref, kind in pending:
        found = names.get(ref, {}) if ref is not None else {}
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


_installed = False


def install_data_change_capture() -> None:
    """挂到 `Session` 类上（所有会话，含 AsyncSession 里那个同步会话）。幂等"""
    global _installed
    if _installed:
        return
    event.listen(Session, 'do_orm_execute', _on_execute)
    event.listen(Session, 'transient_to_pending', _on_pending)
    event.listen(Session, 'after_flush', _on_after_flush)
    event.listen(Session, 'before_commit', _on_before_commit)
    event.listen(Session, 'after_soft_rollback', _on_rollback)
    event.listen(Session, 'after_commit', _on_after_commit)
    _installed = True
