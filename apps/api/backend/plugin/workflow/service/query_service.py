"""审批中心的查询：待我审批 / 我已审批 / 我发起的 / 抄送我的 / 详情 / 监控

🔴 **这里的查询全部按「我是参与人」过滤，不走数据权限。** 审批人通常**不在**单据的
数据范围里，跨部门审批是常态 —— 套上部门数据范围，财务就永远看不到别的部门提交的报销。
所有查询都直接写 SQLAlchemy、不经过 `DataScopedCRUD`，所以不需要 `bypass_data_scope()`；
用户 ID 一律取自 `request.user.id`，不接受客户端传进来的 user_id，越权面为零
（同 `notification` 插件收件箱的口径）。
"""

from __future__ import annotations

import datetime as _dt
import json
import operator

from itertools import starmap
from math import ceil
from typing import TYPE_CHECKING, Any

from sqlalchemy import Select, delete, func, or_, select, true

from backend.app.admin.model import Dept, File, Role, User
from backend.app.admin.service.file_service import register_file_access
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import count_rows
from backend.plugin.workflow.engine.flow import index_nodes
from backend.plugin.workflow.engine.form import (
    hidden_fields_for,
    is_bigint_id,
    node_field_perm,
    start_editable_fields,
)
from backend.plugin.workflow.engine.simulate import simulate
from backend.plugin.workflow.enums import (
    PERM_MONITOR,
    PERM_REASSIGN,
    PERM_TERMINATE,
    Action,
    ApprovalMode,
    FieldPerm,
    TaskStatus,
)
from backend.plugin.workflow.handler import get_handler
from backend.plugin.workflow.model import (
    WfActionRecord,
    WfCc,
    WfDefinition,
    WfDefinitionVersion,
    WfDraft,
    WfInstance,
    WfTask,
)
from backend.plugin.workflow.service.runtime_service import (
    FILE_TARGET,
    Actor,
    capabilities,
    draft_summary,
    due_time,
    resume_jump,
    send_back_targets,
    timeout_of,
)
from backend.plugin.workflow.sys_opinion import render as render_opinion
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from datetime import datetime

    from sqlalchemy.ext.asyncio import AsyncSession


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
        'urgent': inst.urgent,
    }


async def _paged(db: AsyncSession, stmt: Select, page: int, size: int, order_by: Any) -> tuple[list[Any], int]:
    total = await count_rows(db, stmt)
    # 分页必须带 ORDER BY（SQL Server 的 OFFSET FETCH 强制要求）；按雪花 ID 排，同一毫秒内也唯一
    keys = order_by if isinstance(order_by, tuple) else (order_by,)
    rows = (await db.execute(stmt.order_by(*keys).offset((page - 1) * size).limit(size))).all()
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


#: 「按要紧程度排」时一次最多取多少条待办在内存里排。一个人手上的待办通常几条到几十条，这只是防一个异常账号拖垮接口。
#: 超过时**截掉的是最新到手、又没加急的那批**（见 `todo`），`total` / `urgent_total` / `returned_total` 照样是全量数
_ATTENTION_SORT_CAP = 500
#: 排序时「没配超时」的占位（只用来让这些行的第二个键彼此相等）
_NO_DUE = _dt.datetime.min.replace(tzinfo=_dt.UTC)


async def todo(
    db: AsyncSession, user_id: int, *, keyword: str | None, page: int, size: int, sort: str | None = None
) -> dict[str, Any]:
    """待我审批。

    `sort=attention`（工作台用）：加急 → 快到期（超时时间早的在前，没配超时的在后）→ 到手时间新的在前。
    超时时间不是列（按节点配置现算，见 `runtime_service.due_time`），排不进 SQL —— 取出这个人全部的待办在内存里排，
    再切页。默认排序（审批中心）不变：加急在前，其余按到手时间倒序。

    工作台那一份另给两个全量数（大标题和分段要用，不能从取回来的那一页数）：`urgent_total` 加急的几件 ·
    `returned_total` 退回给我、等我改完重新提交的几件
    """
    stmt = (
        select(WfTask, WfInstance, WfDefinition.name)
        .join(WfInstance, WfInstance.id == WfTask.instance_id)
        .join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
        .where(WfTask.assignee_id == user_id, WfTask.status == TaskStatus.pending)
    )
    stmt = _search(stmt, keyword)
    models: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    extra: dict[str, int] = {}
    if sort == 'attention':
        # 🔴 超过上限时留**加急的 + 最老的**：截掉的应该是最不急的那批（最新到手、没加急）。
        # 按「最新的 500 条」截（原来的写法），丢的恰恰是最老、最可能已经超时的待办
        all_rows = (
            await db.execute(stmt.order_by(WfInstance.urgent.desc(), WfTask.id).limit(_ATTENTION_SORT_CAP))
        ).all()
        items = [_todo_row(tk, i, n, models) for tk, i, n in all_rows]
        # 稳定排序分三趟：先按最后一个键排，再按前面的键
        items.sort(key=operator.itemgetter('arrived_time'), reverse=True)
        # 没配超时的那些第二个键一律一样（`_NO_DUE`），保住上一趟排好的「到手时间新的在前」——
        # 拿到手时间顶替的话，它们会按到手时间**正序**重排（测试里抓到过）
        items.sort(key=lambda r: (r['due_time'] is None, r['due_time'] or _NO_DUE))
        items.sort(key=lambda r: not r['urgent'])
        # 全量数单独 count：取回来的最多 `_ATTENTION_SORT_CAP` 条，拿它的长度当 total 会被封顶
        total = await count_rows(db, stmt)
        extra['urgent_total'] = await count_rows(db, stmt.where(WfInstance.urgent == true()))
        # 「退回给我」= 开始节点上的待办。开始节点的 id 在快照 JSON 里、不是列，SQL 里按「办理人就是发起人」认：
        # 审批人解析永远去掉发起人（`engine/assignee.py`），转交 / 改派 / 加签给发起人都会被拒，
        # 所以发起人手上的在办待办只可能是被退回的那一条
        # （`test_urgent_and_returned_totals_count_beyond_the_page` 守着两边一致）
        extra['returned_total'] = await count_rows(db, stmt.where(WfInstance.initiator_id == WfTask.assignee_id))
        items = items[(page - 1) * size : page * size]
    else:
        # 加急的排前面（发起人标的），其余按到手时间倒序
        rows, total = await _paged(db, stmt, page, size, (WfInstance.urgent.desc(), WfTask.id.desc()))
        items = [_todo_row(tk, i, n, models) for tk, i, n in rows]
    await _todo_extras(db, items)
    return {**_page(await _finish_rows(db, items), total, page, size), **extra}


def _todo_row(
    tk: WfTask,
    inst: WfInstance,
    definition_name: str | None,
    models: dict[str, tuple[dict[str, Any], dict[str, Any]]],
) -> dict[str, Any]:
    # 同一份快照只解析、只建一次节点索引：一页里多数行来自同一个流程版本，逐行 `index_nodes` 是 O(行数 × 节点数)
    cached = models.get(inst.model_snapshot)
    if cached is None:
        model = json.loads(inst.model_snapshot)
        cached = models.setdefault(inst.model_snapshot, (model, index_nodes(model)))
    model, nodes = cached
    cfg = timeout_of(model, tk.node_id, nodes=nodes)
    return {
        **_instance_row(inst, definition_name),
        'task_id': tk.id,
        'node_name': tk.node_name,
        'arrived_time': tk.created_time,
        # 节点配了超时：什么时候到点、到点做什么（remind 提醒 / approve 自动同意 / reject 自动驳回）
        'due_time': due_time(tk, model, nodes=nodes),
        'timeout_action': cfg['action'] if cfg else None,
        # 被退回到发起人（开始节点上的待办）：「改完重新提交」，不是一张要审批的单
        'back': tk.node_id == model['root']['id'],
        '_origin_id': tk.origin_assignee_id,
        '_node_id': tk.node_id,
        '_assignee_id': tk.assignee_id,
        '_dept_id': inst.initiator_dept_id,
    }


async def _todo_extras(db: AsyncSession, items: list[dict[str, Any]]) -> None:
    """一页里所有行一次查完（不是 N+1）：谁转交 / 改派过来的 · 发起人部门 · 退回的人和原因"""
    handed = await _latest_handover(db, [r['id'] for r in items if r['_origin_id']])
    dept_ids = {r['_dept_id'] for r in items if r['_dept_id']}
    depts = dict((await db.execute(select(Dept.id, Dept.name).where(Dept.id.in_(dept_ids)))).all()) if dept_ids else {}
    backs = await _latest_send_back(db, [r['id'] for r in items if r['back']])
    for r in items:
        key = (r['id'], r.pop('_node_id'), r.pop('_assignee_id'))
        by, how = handed.get(key, (None, None)) if r.pop('_origin_id') else (None, None)
        r['transferred_from'] = by
        #: `transfer` = 上一个办理人转交给我 · `reassign` = 管理员改派给我（含离职交接）
        r['transfer_kind'] = how
        r['initiator_dept'] = depts.get(r.pop('_dept_id') or 0)
        by, reason = backs.get(r['id'], (None, None))
        r['back_by'] = by if r['back'] else None
        r['back_reason'] = reason if r['back'] else None


async def _latest_handover(
    db: AsyncSession, instance_ids: list[int]
) -> dict[tuple[int, str, int], tuple[str | None, str]]:
    """每条转交 / 改派过来的待办：**最近一次**是谁、用哪种方式交到这个人手上的（按 单 × 节点 × 接手的人 认）。

    🔴 不能用 `wf_task.origin_assignee_id`：那是转交链上**最初**那个人（依次审批按它接着排队），A → B → C 时
    C 看到的会是「A 转交给你」；管理员改派也写它，说成「转交」也不对
    """
    if not instance_ids:
        return {}
    rows = (
        await db.execute(
            select(
                WfActionRecord.instance_id,
                WfActionRecord.node_id,
                WfActionRecord.target_user_id,
                WfActionRecord.actor_name,
                WfActionRecord.action,
            )
            .where(
                WfActionRecord.instance_id.in_(instance_ids),
                WfActionRecord.action.in_([Action.transfer, Action.reassign]),
                WfActionRecord.result == 'ok',
            )
            .order_by(WfActionRecord.created_time, WfActionRecord.id)
        )
    ).all()
    # 按时间正序扫，后面的覆盖前面的 = 最近一次
    return {
        (iid, node, target): (actor, getattr(action, 'value', action))
        for iid, node, target, actor, action in rows
        if target
    }


async def _latest_send_back(db: AsyncSession, instance_ids: list[int]) -> dict[int, tuple[str | None, str | None]]:
    """每张单最近一次「退回」是谁退的、原因是什么"""
    if not instance_ids:
        return {}
    rows = (
        await db.execute(
            select(WfActionRecord.instance_id, WfActionRecord.actor_name, WfActionRecord.opinion)
            .where(
                WfActionRecord.instance_id.in_(instance_ids),
                WfActionRecord.action == Action.send_back,
                WfActionRecord.result == 'ok',
            )
            .order_by(WfActionRecord.created_time, WfActionRecord.id)
        )
    ).all()
    # 按时间正序扫，后面的覆盖前面的 = 最近一次
    return {iid: (actor, opinion) for iid, actor, opinion in rows}


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


#: `progress=true` 每行要推演一遍后面的步骤（`simulate` 会解析审批人），只给小页（工作台）用
PROGRESS_MAX_SIZE = 10

#: 「最后一步」那一行说的结论性动作。催办 / 抄送 / 分支 / 跳过这些不算
_DECISIVE = frozenset({
    'start',
    'approve',
    'reject',
    'send_back',
    'resubmit',
    'withdraw',
    'terminate',
    # 超时自动处理（`runtime_service.apply_timeout` 记的就是这两个名字，`_PROGRESS` 里也是）
    'timeout_approve',
    'timeout_reject',
    # 节点取不到审批人、按 onEmpty 自动驳回
    'auto_reject',
    'ai_approve',
    'transfer',
    'reassign',
    'take_back',
    'add_sign',
})


async def initiated(
    db: AsyncSession,
    user_id: int,
    *,
    keyword: str | None,
    status: str | None,
    page: int,
    size: int,
    progress: bool = False,
) -> dict[str, Any]:
    stmt = (
        select(WfInstance, WfDefinition.name)
        .join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
        .where(WfInstance.initiator_id == user_id)
    )
    if status:
        stmt = stmt.where(WfInstance.status == status)
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfInstance.id.desc())
    items = await _finish_rows(db, list(starmap(_instance_row, rows)))
    if progress:
        await _with_progress(db, [i for i, _ in rows], items)
    return _page(items, total, page, size)


async def _with_progress(db: AsyncSession, insts: list[WfInstance], items: list[dict[str, Any]]) -> None:
    """工作台「我发起的」：每张单走到哪了 —— 步骤条（走过的 / 当前 / 后面的）+ 在谁手上 + 等了多久 + 最后一步结论。

    🔴 **后面的步骤只在推演得出来时给**（和详情页的预告同一套 `simulate`）。条件分支用到了发起人看不到的字段时
    详情页不给预告，这里也不给（`next_steps: null`）—— 前端画「后面还有」，不能编一个出来
    """
    if not insts:
        return
    ids = [i.id for i in insts]
    tasks = list((await db.scalars(select(WfTask).where(WfTask.instance_id.in_(ids)).order_by(WfTask.id))).all())
    records = (
        await db.execute(
            select(
                WfActionRecord.instance_id,
                WfActionRecord.action,
                WfActionRecord.actor_name,
                WfActionRecord.opinion,
                WfActionRecord.opinion_i18n,
                WfActionRecord.created_time,
            )
            .where(WfActionRecord.instance_id.in_(ids), WfActionRecord.result == 'ok')
            .order_by(WfActionRecord.created_time, WfActionRecord.id)
        )
    ).all()
    by_inst: dict[int, list[WfTask]] = {}
    for tk in tasks:
        by_inst.setdefault(tk.instance_id, []).append(tk)
    last: dict[int, dict[str, Any]] = {}
    for iid, action, actor, opinion, opinion_i18n, at in records:
        if action in _DECISIVE:
            # 自动驳回 / 超时 / AI 同意是系统意见：按读的人的语言渲染（sys_opinion.py）
            last[iid] = {
                'action': action,
                'actor_name': actor,
                'opinion': render_opinion(opinion, opinion_i18n),
                'time': at,
            }
    backs = await _latest_send_back(db, ids)

    for inst, row in zip(insts, items, strict=True):
        model = json.loads(inst.model_snapshot)
        nodes = index_nodes(model)
        root = model['root']['id']
        mine = by_inst.get(inst.id, [])
        pending = [tk for tk in mine if tk.status == TaskStatus.pending]
        back = inst.status == 'running' and inst.current_node_id == root
        by, reason = backs.get(inst.id, (None, None))
        row['current_node_name'] = pending[0].node_name if pending and not back else None
        row['handlers'] = [] if back else [tk.assignee_name for tk in pending]
        row['arrived_time'] = min((tk.created_time for tk in pending), default=None)
        row['back'] = back
        row['back_by'] = by if back else None
        row['back_reason'] = reason if back else None
        row['last'] = last.get(inst.id)
        row['steps'] = _steps(mine, root)
        row['next_steps'] = await _next_steps(db, inst, model, nodes, back=back) if inst.status == 'running' else []
        jump = resume_jump(inst, nodes, root) if back else None
        row['resume_to'] = jump.get('name') if jump else None


def _steps(tasks: list[WfTask], root: str) -> list[dict[str, Any]]:
    """这一轮走过的步骤（被退回、重新提交之后从提交那一刻重新算），同一节点同一轮次合成一步。

    每步：`name`（一个人办的写人名，多人写节点名）· `state`（done / current / rejected / sent_back）。
    `sent_back` = 这一步把单退回去了（`decision == 'send_back'`）—— 不能画成同意的绿勾
    """
    start = 0
    for idx, tk in enumerate(tasks):
        if tk.node_id == root and tk.status != TaskStatus.pending:
            start = idx + 1
    groups: dict[tuple[str, int], list[WfTask]] = {}
    for tk in tasks[start:]:
        if tk.node_id == root or tk.status == TaskStatus.canceled:
            continue
        groups.setdefault((tk.node_id, tk.batch), []).append(tk)
    out = []
    for group in groups.values():
        people = {tk.assignee_name for tk in group if tk.status != TaskStatus.transferred}
        if any(tk.status == TaskStatus.pending for tk in group):
            state = 'current'
        elif any(tk.decision == 'reject' for tk in group):
            state = 'rejected'
        elif any(tk.decision == Action.send_back for tk in group):
            state = 'sent_back'
        else:
            state = 'done'
        out.append({'name': next(iter(people)) if len(people) == 1 else group[0].node_name, 'state': state})
    return out


async def _next_steps(
    db: AsyncSession, inst: WfInstance, model: dict[str, Any], nodes: dict[str, Any], *, back: bool
) -> list[str] | None:
    """还没走到的步骤名（推演不了 → None）。被退回时从开始节点往后推（和重新提交之后的实际走法一致）。

    🔴 **审批人来自发起人看不到的人员字段时只给节点名**（同详情页预告的 `_mask_forecast`）：
    步骤条在工作台上原样显示，写出人名 = 把那个隐藏字段的值告诉了发起人
    """
    form_schema = json.loads(inst.form_snapshot)
    approval_nodes = [r.node for r in nodes.values() if r.node['type'] == 'approval']
    hidden = hidden_fields_for(form_schema, approval_nodes, see_all=False, participant_nodes=[model['root']])
    if any(
        r.node['type'] == 'condition'
        and any(v in hidden for b in r.node['branches'] for v in _cond_vars(b.get('when')))
        for r in nodes.values()
    ):
        return None
    current = model['root']['id'] if back else inst.current_node_id
    if current not in nodes:
        return None
    variables = json.loads(inst.variables)
    steps = await simulate(
        db,
        model,
        form_data={**(variables.get('biz') or {}), **json.loads(inst.form_data)},
        initiator_id=inst.initiator_id,
        initiator_dept_id=inst.initiator_dept_id,
        selected=variables.get('selected') or {},
        start_from=resume_jump(inst, nodes, current) or nodes[current].after,
    )
    out = []
    for st in _mask_forecast(steps, nodes, hidden):
        if st.get('outcome') == 'skip' or st.get('type') != 'approval':
            continue
        users = st.get('users') or []
        out.append(users[0]['name'] if len(users) == 1 and not st.get('masked') else st['name'])
        if st.get('outcome') == 'reject':
            break
    return out


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


async def monitor(
    db: AsyncSession,
    *,
    keyword: str | None,
    status: str | None,
    definition_id: int | None = None,
    initiator: str | None = None,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
    page: int,
    size: int,
) -> dict[str, Any]:
    stmt = select(WfInstance, WfDefinition.name).join(WfDefinition, WfDefinition.id == WfInstance.definition_id)
    if status:
        stmt = stmt.where(WfInstance.status == status)
    if definition_id:
        stmt = stmt.where(WfInstance.definition_id == definition_id)
    if initiator:
        # 按姓名 / 用户名模糊找发起人（离职停用的也算 —— 查的是历史单子）
        like = f'%{initiator}%'
        stmt = stmt.where(
            WfInstance.initiator_id.in_(select(User.id).where(or_(User.nickname.like(like), User.username.like(like))))
        )
    if start_time:
        stmt = stmt.where(WfInstance.created_time >= start_time)
    if end_time:
        stmt = stmt.where(WfInstance.created_time <= end_time)
    rows, total = await _paged(db, _search(stmt, keyword), page, size, WfInstance.id.desc())
    items = await _finish_rows(db, list(starmap(_instance_row, rows)))
    # 监控最常问的一句「卡在谁手上」：在办的单子带上当前这一步和办理人（本页一次查完，不是 N+1）
    pending = (
        (
            await db.execute(
                select(WfTask.instance_id, WfTask.node_name, WfTask.assignee_name)
                .where(WfTask.instance_id.in_([r['id'] for r in items]), WfTask.status == TaskStatus.pending)
                .order_by(WfTask.id)
            )
        ).all()
        if items
        else []
    )
    by_inst: dict[int, tuple[str, list[str]]] = {}
    for iid, node_name, who in pending:
        by_inst.setdefault(iid, (node_name, []))[1].append(who)
    for r in items:
        node_name, handlers = by_inst.get(r['id'], (None, []))
        r['current_node_name'] = node_name
        r['handlers'] = handlers
    return _page(items, total, page, size)


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


async def _viewer(db: AsyncSession, inst: WfInstance, actor: Actor) -> tuple[list[WfTask], list[WfCc], set[str]]:
    """这个人能不能看这张单、看不到哪些字段。看不了报 404。

    详情接口和「附件能不能下载」（`_workflow_file_access`）用的是这一个判断 ——
    两边各算一遍的话，迟早出现「详情里看不到这个附件，却能按 ID 下载」
    """
    pk = inst.id
    tasks = list((await db.scalars(select(WfTask).where(WfTask.instance_id == pk).order_by(WfTask.id))).all())
    ccs = list((await db.scalars(select(WfCc).where(WfCc.instance_id == pk).order_by(WfCc.id))).all())
    is_initiator = inst.initiator_id == actor.id
    my_tasks = [tk for tk in tasks if tk.assignee_id == actor.id]
    is_cc = any(c.user_id == actor.id for c in ccs)
    # 和 runtime_service._can_view 同一个口径：能管实例的（看 / 终止 / 改办理人）都看得到全部
    is_monitor = any(actor.has(p) for p in (PERM_MONITOR, PERM_TERMINATE, PERM_REASSIGN))
    # 看不见的单据报 404 而不是 403：403 等于告诉对方「这个 ID 存在」
    if not (is_initiator or my_tasks or is_cc or is_monitor):
        raise errors.NotFoundError(msg=t('error.workflow.instance_not_found'))
    await get_handler(inst.biz_type).assert_view_allowed(db, inst.biz_id, actor.id)

    form_schema = json.loads(inst.form_snapshot)
    model = json.loads(inst.model_snapshot)
    nodes = index_nodes(model)
    approval_nodes = [r.node for r in nodes.values() if r.node['type'] == 'approval']
    participant_nodes = [nodes[tk.node_id].node for tk in my_tasks if tk.node_id in nodes]
    # 发起人按开始节点的字段权限看（没配 = 看得到）；被设成 hidden 的是留给审批人的字段
    if is_initiator:
        participant_nodes.append(model['root'])
    hidden = hidden_fields_for(
        form_schema,
        approval_nodes,
        see_all=is_monitor,
        participant_nodes=participant_nodes,
    )
    return tasks, ccs, hidden


async def viewer_scope(db: AsyncSession, inst: WfInstance, actor: Actor) -> set[str]:
    """看不了报 404；看得了返回他看不到的字段。AI 预审的查看 / 重试用同一个口径（不另算一遍）"""
    _, _, hidden = await _viewer(db, inst, actor)
    return hidden


async def detail(db: AsyncSession, pk: int, actor: Actor) -> dict[str, Any]:  # ruff:ignore[complex-structure]
    inst = await db.get(WfInstance, pk)
    if inst is None:
        raise errors.NotFoundError(msg=t('error.workflow.instance_not_found'))
    tasks, ccs, hidden = await _viewer(db, inst, actor)
    form_schema = json.loads(inst.form_snapshot)
    model = json.loads(inst.model_snapshot)
    nodes = index_nodes(model)
    # 🔴 隐藏字段在**服务端**裁掉：schema 里删字段、数据里删值。前端藏起来不算权限
    form_data = {k: v for k, v in json.loads(inst.form_data).items() if k not in hidden}
    form_schema = {**form_schema, 'fields': [f for f in form_schema.get('fields') or [] if f['id'] not in hidden]}

    caps, my_task = await capabilities(db, inst, actor)
    perms: dict[str, str] = {}
    if my_task is not None and my_task.node_id == model['root']['id']:
        # 被退回到发起人：按开始节点的权限改（默认可填）
        editable = start_editable_fields(form_schema, model['root'])
        perms = {
            f['id']: FieldPerm.editable if f['id'] in editable else FieldPerm.readonly for f in form_schema['fields']
        }
    elif my_task is not None:
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
    definition_name, definition_code = (
        await db.execute(select(WfDefinition.name, WfDefinition.code).where(WfDefinition.id == inst.definition_id))
    ).one()

    # 🔴 条件分支用到了这个查看人看不到的字段：走了哪条分支 = 那个字段的取值区间（「金额 > 1 万」走了左边）。
    # 对他抹掉分支标签和整段预告；用到隐藏的人员字段取审批人的，预告里也不给名字（独立审查发现）。
    # ⚠️ 抹不干净：已经走过的节点本身就暴露了路径 —— 发布校验对这种配置给 WARN（CONDITION_VAR_HIDDEN）
    sensitive_conds = {
        r.node['id']
        for r in nodes.values()
        if r.node['type'] == 'condition'
        and any(v in hidden for b in r.node['branches'] for v in _cond_vars(b.get('when')))
    }
    records = [r for r in records if not (r.action == 'branch' and r.node_id in sensitive_conds)]

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
            # 「重新发起」要知道从哪个流程发起（复制成新单，旧单不动 —— #107 生命周期第 3 条）
            'definition_code': definition_code,
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
                'batch': tk.batch,
                'read_time': tk.read_time,
                'status': tk.status,
                # 节点配了超时：什么时候会被提醒 / 自动处理（前端在进度里写「X 点自动通过」）
                'due_time': due_time(tk, model) if tk.status == TaskStatus.pending else None,
                'decision': tk.decision,
                'opinion': render_opinion(tk.opinion, tk.opinion_i18n),
                'created_time': tk.created_time,
                'finished_time': tk.finished_time,
            }
            for tk in tasks
        ],
        'records': [
            {
                'id': r.id,
                'task_id': r.task_id,
                'action': r.action,
                'actor_type': r.actor_type,
                'actor_id': r.actor_id,
                'actor_name': r.actor_name,
                'node_id': r.node_id,
                'node_name': r.node_name,
                'target_user_name': r.target_user_name,
                'opinion': render_opinion(r.opinion, r.opinion_i18n),
                'detail': _strip_hidden(json.loads(r.detail), hidden) if r.detail else None,
                'created_time': r.created_time,
            }
            for r in records
        ],
        'ccs': [{'user_id': c.user_id, 'user_name': names.get(c.user_id), 'read_time': c.read_time} for c in ccs],
        'capabilities': [{'action': c.action, 'enabled': c.enabled, 'reason': c.reason} for c in caps],
        'names': await model_names(db, model),
        'files': await _attachment_meta(db, form_schema, form_data),
        # 还没走到的步骤（预告）。只在运行中时有；和真实推进同一套规则（engine/simulate.py）
        'forecast': _mask_forecast(
            await simulate(
                db,
                model,
                form_data={**(json.loads(inst.variables).get('biz') or {}), **json.loads(inst.form_data)},
                initiator_id=inst.initiator_id,
                initiator_dept_id=inst.initiator_dept_id,
                selected=json.loads(inst.variables).get('selected') or {},
                # 退回时选了「直接回到我这一步」：这一步办完跳回去，预告也从那一步算（和 `_leave_node` 同一个判断）
                start_from=resume_jump(inst, nodes, inst.current_node_id) or nodes[inst.current_node_id].after,
            )
            if inst.status == 'running' and inst.current_node_id in nodes and not sensitive_conds
            else [],
            nodes,
            hidden,
        ),
        'my_task_id': my_task.id if my_task else None,
        # 退回能选哪些节点：只给有「退回」这个动作的人算（要沿树走一遍）
        'send_back_targets': (
            await send_back_targets(db, inst) if any(c.action == Action.send_back for c in caps) else []
        ),
        'waiting': _waiting(inst, nodes, tasks, hidden),
        # 被退回到发起人：重新提交时可以（也可能必须）为「发起人自选」节点选人。服务端按新的表单判哪些必选
        'select_nodes': (
            [
                {
                    'id': r.node['id'],
                    'name': r.node['name'],
                    'selected': (json.loads(inst.variables).get('selected') or {}).get(r.node['id'], []),
                }
                for r in nodes.values()
                if r.node['type'] == 'approval' and (r.node.get('assignee') or {}).get('kind') == 'select_on_start'
            ]
            if my_task is not None and my_task.node_id == model['root']['id']
            else []
        ),
    }


def _waiting(inst: WfInstance, nodes: dict[str, Any], tasks: list[WfTask], hidden: set[str]) -> list[dict[str, Any]]:
    """依次审批的当前节点上，排在后面、还没轮到的人（按顺序）。

    审批人来自查看人看不到的人员字段时不给名字（同预告的 `_mask_forecast`）
    """
    nid = inst.current_node_id
    if inst.status != 'running' or nid not in nodes:
        return []
    node = nodes[nid].node
    if node['type'] != 'approval' or node.get('mode') != ApprovalMode.seq:
        return []
    rule = node.get('assignee') or {}
    if rule.get('kind') == 'var_user' and rule.get('field') in hidden:
        return [{'id': None, 'name': None, 'masked': True}]
    queue = (json.loads(inst.variables).get('queue') or {}).get(nid) or []
    batch = max((tk.batch for tk in tasks if tk.node_id == nid), default=None)
    reached = {tk.origin_assignee_id or tk.assignee_id for tk in tasks if tk.node_id == nid and tk.batch == batch}
    ids = [u for u, _ in queue]
    last = max((ids.index(u) for u in reached if u in ids), default=-1)
    return [{'id': u, 'name': n} for u, n in queue[last + 1 :]]


def _strip_hidden(detail: dict[str, Any], hidden: set[str]) -> dict[str, Any]:
    """轨迹里的表单改动前后值也要按字段权限裁 —— 不然隐藏字段从轨迹里漏出去"""
    if 'form_changes' in detail:
        detail = {**detail, 'form_changes': {k: v for k, v in detail['form_changes'].items() if k not in hidden}}
    return detail


async def mark_cc_read(db: AsyncSession, pk: int, user_id: int) -> None:
    cc = await db.scalar(select(WfCc).where(WfCc.instance_id == pk, WfCc.user_id == user_id))
    if cc is not None and cc.read_time is None:
        cc.read_time = timezone.now()


# ── 通讯录（选人 / 选部门）──────────────────────────────────────────────────


async def directory_users(db: AsyncSession, *, keyword: str | None, ids: list[int] | None) -> list[dict[str, Any]]:
    """选人控件用的最小通讯录：只给 ID / 昵称 / 用户名 / 部门名。

    审批里的选人（转交、抄送、发起人自选审批人、表单里的人员字段）是**所有登录用户**都要用的，
    而 `/sys/users` 挂着 `sys:user:list` —— 普通员工调不了。这里只暴露选人需要的几列，
    不给手机号 / 邮箱 / 状态这些。
    """
    stmt = (
        select(User.id, User.nickname, User.username, Dept.name)
        .outerjoin(Dept, Dept.id == User.dept_id)
        .where(User.deleted == 0, User.status == 1)
    )
    if ids:
        stmt = stmt.where(User.id.in_(ids[:100]))
    elif keyword:
        stmt = stmt.where(or_(User.nickname.like(f'%{keyword}%'), User.username.like(f'%{keyword}%')))
    rows = (await db.execute(stmt.order_by(User.id).limit(100 if ids else 20))).all()
    return [{'id': r[0], 'nickname': r[1], 'username': r[2], 'dept_name': r[3]} for r in rows]


async def users_named(db: AsyncSession, name: str) -> list[dict[str, Any]]:
    """用户名或昵称**精确**等于 `name` 的在职账号（AI 转交按名字找人用）。

    🔴 不能拿 `directory_users` 的模糊搜索再筛：那个结果按 ID 截在 20 条，「张伟」能模糊命中几十个人
    （张伟东、张伟明…），第二个同名的「张伟」排在 20 条之后就被截掉 —— 重名不猜那条规则静默失效
    """
    rows = (
        await db.execute(
            select(User.id, User.nickname, User.username, Dept.name)
            .outerjoin(Dept, Dept.id == User.dept_id)
            .where(User.deleted == 0, User.status == 1, or_(User.username == name, User.nickname == name))
            .order_by(User.id)
            .limit(50)
        )
    ).all()
    return [{'id': r[0], 'nickname': r[1], 'username': r[2], 'dept_name': r[3]} for r in rows]


async def directory_depts(db: AsyncSession) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(Dept.id, Dept.name, Dept.parent_id)
            .where(Dept.deleted == 0, Dept.status == 1)
            .order_by(Dept.sort, Dept.id)
        )
    ).all()
    return [{'id': r[0], 'name': r[1], 'parent_id': r[2]} for r in rows]


async def directory_roles(db: AsyncSession) -> list[dict[str, Any]]:
    """设计器里「指定角色」的下拉。`/sys/roles/all` 要 `sys:role:list`，配流程的人不一定有"""
    rows = (
        await db.execute(
            select(Role.id, Role.name, Role.code).where(Role.status == 1, Role.deleted == 0).order_by(Role.id)
        )
    ).all()
    return [{'id': r[0], 'name': r[1], 'code': r[2]} for r in rows]


async def model_names(db: AsyncSession, model: dict[str, Any]) -> dict[str, dict[str, str]]:
    """流程模型里出现过的用户 / 角色 ID → 名字，给只读流程图显示用。

    模型里只存 ID（名字会变）；而看流程图的人（发起人、审批人）不一定有权限调角色 / 用户接口，
    所以由服务端顺手查好一起下发。ID 键是字符串（硬纪律 6）。
    """
    users: set[int] = set()
    roles: set[int] = set()

    def scan(o: Any) -> None:
        if isinstance(o, dict):
            users.update(int(x) for x in o.get('user_ids') or [] if is_bigint_id(x))
            roles.update(int(x) for x in o.get('role_ids') or [] if is_bigint_id(x))
            for v in o.values():
                scan(v)
        elif isinstance(o, list):
            for v in o:
                scan(v)

    scan(model)
    out: dict[str, dict[str, str]] = {'users': {}, 'roles': {}}
    if users:
        rows = await db.execute(select(User.id, User.nickname).where(User.id.in_(users)))
        out['users'] = {str(k): v for k, v in rows.all()}
    if roles:
        rows = await db.execute(select(Role.id, Role.name).where(Role.id.in_(roles)))
        out['roles'] = {str(k): v for k, v in rows.all()}
    return out


async def _attachment_meta(
    db: AsyncSession, form_schema: dict[str, Any], form_data: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    """表单里（**已经按字段权限裁过的**）附件 → 文件名 / 大小，一次查回来。

    只给看得见的字段查：隐藏字段里的附件连名字都不该漏出去。
    """
    ids: set[int] = set()
    for f in form_schema.get('fields') or []:
        if f['type'] == 'attachment':
            ids |= {int(x) for x in form_data.get(f['id']) or [] if is_bigint_id(x)}
    if not ids:
        return {}
    rows = (
        await db.execute(
            select(File.id, File.original_name, File.size, File.ext, File.content_type).where(
                File.id.in_(ids), File.deleted == 0
            )
        )
    ).all()
    return {str(r[0]): {'name': r[1], 'size': r[2], 'ext': r[3], 'content_type': r[4]} for r in rows}


def _cond_vars(cond: dict[str, Any] | None) -> list[str]:
    if not cond:
        return []
    out: list[str] = []
    for k in ('all', 'any'):
        for c in cond.get(k) or []:
            out += _cond_vars(c)
    if cond.get('var'):
        out.append(cond['var'])
    return out


def _mask_forecast(steps: list[dict[str, Any]], nodes: dict[str, Any], hidden: set[str]) -> list[dict[str, Any]]:
    """预告里由「表单人员字段」解析出来的人，字段对查看人隐藏时不给名字"""
    if not hidden:
        return steps
    out = []
    for st in steps:
        node = nodes[st['node_id']].node
        rules = [node.get('assignee') or {}] if node['type'] == 'approval' else node.get('targets') or []
        if any(r.get('kind') == 'var_user' and r.get('field') in hidden for r in rules):
            st = {**st, 'users': [], 'masked': True}
        out.append(st)
    return out


# ── 附件下载权限 ─────────────────────────────────────────────────────────────


async def _workflow_file_access(db: AsyncSession, user: Any, file: Any) -> bool:
    """审批单上的附件：能看这张单、且那个附件字段对他不是 hidden，才能下载。

    「挂在哪几张单上」查 `sys_file_relation`（发起 / 审批改表单时同步，按 `file_id` 走索引）；
    看不看得见逐张过 `_viewer()` —— 和详情接口同一个判断
    """
    from backend.app.admin.model import FileRelation

    actor = Actor.from_user(user)
    ids = (
        await db.scalars(
            select(FileRelation.target_id)
            .where(FileRelation.file_id == file.id, FileRelation.target_type == FILE_TARGET, FileRelation.deleted == 0)
            .limit(50)
        )
    ).all()
    if not ids:
        return False
    for inst in (await db.scalars(select(WfInstance).where(WfInstance.id.in_(ids)))).all():
        try:
            _, _, hidden = await _viewer(db, inst, actor)
        except errors.BaseExceptionError:
            continue
        data = json.loads(inst.form_data)
        for f in json.loads(inst.form_snapshot).get('fields') or []:
            if f['type'] == 'attachment' and f['id'] not in hidden and str(file.id) in (data.get(f['id']) or []):
                return True
    return False


register_file_access(_workflow_file_access)


async def mark_task_read(db: AsyncSession, pk: int, user_id: int) -> None:
    """办理人打开了这张单：他手上还在办的待办记一次「已读」（只记第一次）"""
    for tk in (
        await db.scalars(
            select(WfTask).where(
                WfTask.instance_id == pk,
                WfTask.assignee_id == user_id,
                WfTask.status == TaskStatus.pending,
                WfTask.read_time.is_(None),
            )
        )
    ).all():
        tk.read_time = timezone.now()


# ── 发起草稿 ─────────────────────────────────────────────────────────────────

#: 草稿整份存一个 TEXT 列：给个上限，不让一份草稿塞几 MB
DRAFT_MAX_BYTES = 200_000


async def drafts(db: AsyncSession, user_id: int) -> list[dict[str, Any]]:
    """我的发起草稿。带上流程名和一行摘要（按当前发布版本的表单拼，同待办列表的 `summary`）"""
    rows = (await db.scalars(select(WfDraft).where(WfDraft.user_id == user_id).order_by(WfDraft.id))).all()
    defs: dict[str, tuple[str, str, str]] = {}
    if rows:
        found = await db.execute(
            select(WfDefinition.code, WfDefinition.name, WfDefinitionVersion.form_json, WfDefinitionVersion.model_json)
            .join(WfDefinitionVersion, WfDefinitionVersion.id == WfDefinition.current_version_id)
            .where(WfDefinition.code.in_([d.code for d in rows]), WfDefinition.deleted == 0)
        )
        defs = {code: (name, form_json, model_json) for code, name, form_json, model_json in found.all()}
    out = []
    for d in rows:
        name, form_json, model_json = defs.get(d.code, (None, None, None))
        summary = None
        if form_json and model_json:
            try:
                summary = draft_summary(json.loads(form_json), json.loads(d.form_data), json.loads(model_json))
            except (ValueError, KeyError, TypeError):  # 草稿是存下的半成品，拼不出摘要不算错
                summary = None
        out.append({'code': d.code, 'name': name, 'summary': summary, 'updated_time': d.updated_time or d.created_time})
    return out


async def get_draft(db: AsyncSession, user_id: int, code: str) -> dict[str, Any] | None:
    d = await db.scalar(select(WfDraft).where(WfDraft.user_id == user_id, WfDraft.code == code))
    if d is None:
        return None
    return {
        'form': json.loads(d.form_data),
        'ai_filled': json.loads(d.ai_filled) if d.ai_filled else [],
        'updated_time': d.updated_time or d.created_time,
    }


async def save_draft(
    db: AsyncSession, user_id: int, code: str, form: dict[str, Any], ai_filled: list[str] | None = None
) -> None:
    """存草稿。不校验内容（填到一半本来就不完整），只限大小；提交时照常完整校验"""
    raw = json.dumps(form, ensure_ascii=False)
    if len(raw.encode()) > DRAFT_MAX_BYTES:
        raise errors.RequestError(msg=t('error.workflow.draft_too_large'))
    d = await db.scalar(select(WfDraft).where(WfDraft.user_id == user_id, WfDraft.code == code))
    marks = json.dumps(ai_filled, ensure_ascii=False) if ai_filled else None
    if d is None:
        db.add(WfDraft(user_id=user_id, code=code, form_data=raw, ai_filled=marks))
    else:
        d.form_data = raw
        d.ai_filled = marks
        d.updated_time = timezone.now()


async def delete_draft(db: AsyncSession, user_id: int, code: str) -> None:
    await db.execute(delete(WfDraft).where(WfDraft.user_id == user_id, WfDraft.code == code))
