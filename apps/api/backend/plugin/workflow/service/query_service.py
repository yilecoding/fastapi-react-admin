"""审批中心的查询：待我审批 / 我已审批 / 我发起的 / 抄送我的 / 详情 / 监控

🔴 **这里的查询全部按「我是参与人」过滤，不走数据权限。** 审批人通常**不在**单据的
数据范围里，跨部门审批是常态 —— 套上部门数据范围，财务就永远看不到别的部门提交的报销。
所有查询都直接写 SQLAlchemy、不经过 `DataScopedCRUD`，所以不需要 `bypass_data_scope()`；
用户 ID 一律取自 `request.user.id`，不接受客户端传进来的 user_id，越权面为零
（同 `notification` 插件收件箱的口径）。
"""

from __future__ import annotations

import json

from itertools import starmap
from math import ceil
from typing import TYPE_CHECKING, Any

from sqlalchemy import Select, func, or_, select

from backend.app.admin.model import User
from backend.common.exception import errors
from backend.common.i18n import t
from backend.plugin.workflow.engine.flow import index_nodes
from backend.plugin.workflow.engine.form import hidden_fields_for, node_field_perm
from backend.plugin.workflow.enums import PERM_TERMINATE, TaskStatus
from backend.plugin.workflow.handler import get_handler
from backend.plugin.workflow.model import WfActionRecord, WfCc, WfDefinition, WfInstance, WfTask
from backend.plugin.workflow.service.runtime_service import Actor, capabilities
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

#: 实例监控（看全部在途实例）要的权限码
PERM_MONITOR = 'workflow:instance:list'


def _page(items: list[dict[str, Any]], total: int, page: int, size: int) -> dict[str, Any]:
    """和 `common/pagination.py` 的分页形状一致。这里的列表是 join 出来的多列，交不了 `paging_data`"""
    pages = ceil(total / size) if size else 0
    return {
        'items': items,
        'total': total,
        'page': page,
        'size': size,
        'total_pages': pages,
        'links': {
            'first': f'?page=1&size={size}',
            'last': f'?page={max(pages, 1)}&size={size}',
            'self': f'?page={page}&size={size}',
            'next': f'?page={page + 1}&size={size}' if page + 1 <= pages else None,
            'prev': f'?page={page - 1}&size={size}' if page - 1 >= 1 else None,
        },
    }


def _instance_row(inst: WfInstance, definition_name: str | None) -> dict[str, Any]:
    return {
        'id': inst.id,
        'title': inst.title,
        'summary': inst.summary,
        'definition_id': inst.definition_id,
        'definition_name': definition_name,
        'biz_type': inst.biz_type,
        'status': inst.status,
        'initiator_id': inst.initiator_id,
        'current_node_id': inst.current_node_id,
        'created_time': inst.created_time,
        'finished_time': inst.finished_time,
    }


async def _paged(db: AsyncSession, stmt: Select, page: int, size: int, order_by: Any) -> tuple[list[Any], int]:
    total = await db.scalar(select(func.count()).select_from(stmt.order_by(None).subquery())) or 0
    # 分页必须带 ORDER BY（SQL Server 的 OFFSET FETCH 强制要求）；按雪花 ID 排，同一毫秒内也唯一
    rows = (await db.execute(stmt.order_by(order_by).offset((page - 1) * size).limit(size))).all()
    return list(rows), total


async def _initiator_names(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    return dict((await db.execute(select(User.id, User.nickname).where(User.id.in_(ids)))).all())


def _search(stmt: Select, keyword: str | None) -> Select:
    if keyword:
        stmt = stmt.where(or_(WfInstance.title.like(f'%{keyword}%'), WfInstance.summary.like(f'%{keyword}%')))
    return stmt


async def _finish_rows(db: AsyncSession, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    names = await _initiator_names(db, {r['initiator_id'] for r in rows})
    for r in rows:
        r['initiator_name'] = names.get(r['initiator_id'])
    return rows


async def todo(db: AsyncSession, user_id: int, *, keyword: str | None, page: int, size: int) -> dict[str, Any]:
    stmt = (
        select(WfTask, WfInstance, WfDefinition.name)
        .join(WfInstance, WfInstance.id == WfTask.instance_id)
        .join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
        .where(WfTask.assignee_id == user_id, WfTask.status == TaskStatus.pending)
    )
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfTask.id.desc())
    items = [
        {**_instance_row(i, n), 'task_id': tk.id, 'node_name': tk.node_name, 'arrived_time': tk.created_time}
        for tk, i, n in rows
    ]
    return _page(await _finish_rows(db, items), total, page, size)


async def done(db: AsyncSession, user_id: int, *, keyword: str | None, page: int, size: int) -> dict[str, Any]:
    stmt = (
        select(WfTask, WfInstance, WfDefinition.name)
        .join(WfInstance, WfInstance.id == WfTask.instance_id)
        .join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
        .where(
            WfTask.assignee_id == user_id,
            WfTask.status.in_([TaskStatus.done, TaskStatus.transferred]),
        )
    )
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfTask.id.desc())
    items = [
        {
            **_instance_row(i, n),
            'task_id': tk.id,
            'node_name': tk.node_name,
            'decision': tk.decision or tk.status,
            'handled_time': tk.finished_time,
        }
        for tk, i, n in rows
    ]
    return _page(await _finish_rows(db, items), total, page, size)


async def initiated(
    db: AsyncSession, user_id: int, *, keyword: str | None, status: str | None, page: int, size: int
) -> dict[str, Any]:
    stmt = (
        select(WfInstance, WfDefinition.name)
        .join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
        .where(WfInstance.initiator_id == user_id)
    )
    if status:
        stmt = stmt.where(WfInstance.status == status)
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfInstance.id.desc())
    return _page(await _finish_rows(db, list(starmap(_instance_row, rows))), total, page, size)


async def cc_me(
    db: AsyncSession, user_id: int, *, keyword: str | None, unread: bool | None, page: int, size: int
) -> dict[str, Any]:
    stmt = (
        select(WfCc, WfInstance, WfDefinition.name)
        .join(WfInstance, WfInstance.id == WfCc.instance_id)
        .join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
        .where(WfCc.user_id == user_id)
    )
    if unread is True:
        stmt = stmt.where(WfCc.read_time.is_(None))
    elif unread is False:
        stmt = stmt.where(WfCc.read_time.is_not(None))
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfCc.id.desc())
    items = [
        {**_instance_row(i, n), 'cc_id': c.id, 'read_time': c.read_time, 'cc_time': c.created_time} for c, i, n in rows
    ]
    return _page(await _finish_rows(db, items), total, page, size)


async def monitor(db: AsyncSession, *, keyword: str | None, status: str | None, page: int, size: int) -> dict[str, Any]:
    stmt = select(WfInstance, WfDefinition.name).join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
    if status:
        stmt = stmt.where(WfInstance.status == status)
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfInstance.id.desc())
    return _page(await _finish_rows(db, list(starmap(_instance_row, rows))), total, page, size)


async def counts(db: AsyncSession, user_id: int) -> dict[str, int]:
    todo_n = await db.scalar(
        select(func.count())
        .select_from(WfTask)
        .where(WfTask.assignee_id == user_id, WfTask.status == TaskStatus.pending)
    )
    cc_n = await db.scalar(
        select(func.count()).select_from(WfCc).where(WfCc.user_id == user_id, WfCc.read_time.is_(None))
    )
    return {'todo': todo_n or 0, 'cc_unread': cc_n or 0}


# ── 详情 ─────────────────────────────────────────────────────────────────────


async def detail(db: AsyncSession, pk: int, actor: Actor) -> dict[str, Any]:  # ruff:ignore[complex-structure]
    inst = await db.get(WfInstance, pk)
    if inst is None:
        raise errors.NotFoundError(msg=t('error.workflow.instance_not_found'))

    tasks = list((await db.scalars(select(WfTask).where(WfTask.instance_id == pk).order_by(WfTask.id))).all())
    ccs = list((await db.scalars(select(WfCc).where(WfCc.instance_id == pk).order_by(WfCc.id))).all())
    is_initiator = inst.initiator_id == actor.id
    my_tasks = [tk for tk in tasks if tk.assignee_id == actor.id]
    is_cc = any(c.user_id == actor.id for c in ccs)
    is_monitor = actor.has(PERM_MONITOR) or actor.has(PERM_TERMINATE)
    # 看不见的单据报 404 而不是 403：403 等于告诉对方「这个 ID 存在」
    if not (is_initiator or my_tasks or is_cc or is_monitor):
        raise errors.NotFoundError(msg=t('error.workflow.instance_not_found'))
    await get_handler(inst.biz_type).assert_view_allowed(db, inst.biz_id, actor.id)

    form_schema = json.loads(inst.form_snapshot)
    model = json.loads(inst.model_snapshot)
    nodes = index_nodes(model)
    approval_nodes = [r.node for r in nodes.values() if r.node['type'] == 'approval']
    participant_nodes = [nodes[tk.node_id].node for tk in my_tasks if tk.node_id in nodes]
    hidden = hidden_fields_for(
        form_schema,
        approval_nodes,
        see_all=is_initiator or is_monitor,
        participant_nodes=participant_nodes,
    )
    # 🔴 隐藏字段在**服务端**裁掉：schema 里删字段、数据里删值。前端藏起来不算权限
    form_data = {k: v for k, v in json.loads(inst.form_data).items() if k not in hidden}
    form_schema = {**form_schema, 'fields': [f for f in form_schema.get('fields') or [] if f['id'] not in hidden]}

    caps, my_task = await capabilities(db, inst, actor)
    perms: dict[str, str] = {}
    if my_task is not None:
        node = nodes[my_task.node_id].node
        perms = {f['id']: node_field_perm(node, f['id']) for f in form_schema['fields']}

    records = list(
        (
            await db.scalars(
                select(WfActionRecord)
                .where(WfActionRecord.instance_id == pk, WfActionRecord.result == 'ok')
                .order_by(WfActionRecord.created_time, WfActionRecord.id)
            )
        ).all()
    )
    names = await _initiator_names(db, {inst.initiator_id, *(c.user_id for c in ccs)})
    definition_name = await db.scalar(select(WfDefinition.name).where(WfDefinition.id == inst.definition_id))

    # 只读流程图要知道每个节点的状态：走过的 / 当前的 / 没走到的
    node_state: dict[str, str] = {}
    for tk in tasks:
        state = 'current' if tk.status == TaskStatus.pending else 'done'
        if node_state.get(tk.node_id) != 'current':
            node_state[tk.node_id] = state
    for r in records:
        if r.action in {'skip', 'auto_reject', 'cc', 'branch'} and r.node_id:
            node_state.setdefault(r.node_id, 'done' if r.action != 'auto_reject' else 'rejected')
        if r.action == 'branch' and r.detail:
            node_state[f'branch:{json.loads(r.detail)["branch"]}'] = 'taken'
    for tk in tasks:
        if tk.decision == 'reject':
            node_state[tk.node_id] = 'rejected'

    return {
        'instance': {
            **_instance_row(inst, definition_name),
            'initiator_name': names.get(inst.initiator_id),
            'seq': inst.seq,
            'biz_id': inst.biz_id,
        },
        'form_schema': form_schema,
        'form_data': form_data,
        'field_perms': perms,
        'model': model,
        'node_state': node_state,
        'tasks': [
            {
                'id': tk.id,
                'node_id': tk.node_id,
                'node_name': tk.node_name,
                'assignee_id': tk.assignee_id,
                'assignee_name': tk.assignee_name,
                'origin_assignee_id': tk.origin_assignee_id,
                'status': tk.status,
                'decision': tk.decision,
                'opinion': tk.opinion,
                'created_time': tk.created_time,
                'finished_time': tk.finished_time,
            }
            for tk in tasks
        ],
        'records': [
            {
                'id': r.id,
                'action': r.action,
                'actor_type': r.actor_type,
                'actor_id': r.actor_id,
                'actor_name': r.actor_name,
                'node_id': r.node_id,
                'node_name': r.node_name,
                'target_user_name': r.target_user_name,
                'opinion': r.opinion,
                'detail': _strip_hidden(json.loads(r.detail), hidden) if r.detail else None,
                'created_time': r.created_time,
            }
            for r in records
        ],
        'ccs': [{'user_id': c.user_id, 'user_name': names.get(c.user_id), 'read_time': c.read_time} for c in ccs],
        'capabilities': [{'action': c.action, 'enabled': c.enabled, 'reason': c.reason} for c in caps],
        'my_task_id': my_task.id if my_task else None,
    }


def _strip_hidden(detail: dict[str, Any], hidden: set[str]) -> dict[str, Any]:
    """轨迹里的表单改动前后值也要按字段权限裁 —— 不然隐藏字段从轨迹里漏出去"""
    if 'form_changes' in detail:
        detail = {**detail, 'form_changes': {k: v for k, v in detail['form_changes'].items() if k not in hidden}}
    return detail


async def mark_cc_read(db: AsyncSession, pk: int, user_id: int) -> None:
    cc = await db.scalar(select(WfCc).where(WfCc.instance_id == pk, WfCc.user_id == user_id))
    if cc is not None and cc.read_time is None:
        cc.read_time = timezone.now()
