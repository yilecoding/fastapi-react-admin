"""审批超时：扫出到点的待办，逐条交给 `runtime_service.apply_timeout`（规则都在那边）。

由 celery 定时任务 `workflow.handle_timeouts`（`app/task/tasks/workflow/`）每 5 分钟调一次。
每条一个会话、一个事务：一张单出错 / 正好有人在办，不影响后面的单。
"""

from __future__ import annotations

import json

from typing import TYPE_CHECKING, Any

from sqlalchemy import select

from backend.common.log import log
from backend.plugin.workflow.enums import InstanceStatus, TaskStatus
from backend.plugin.workflow.model import WfInstance, WfTask
from backend.plugin.workflow.service.runtime_service import RetryLater, apply_timeout, due_time
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Callable
    from datetime import datetime

    from sqlalchemy.ext.asyncio import AsyncSession


async def _candidates(db: AsyncSession, now: datetime) -> list[tuple[int, int]]:
    """到点了的待办：`(实例 ID, 待办 ID)`。只是候选 —— 真正处理前在事务里再判一遍"""
    rows = (
        await db.execute(
            select(WfTask, WfInstance.model_snapshot)
            .join(WfInstance, WfInstance.id == WfTask.instance_id)
            .where(
                WfTask.status == TaskStatus.pending,
                WfInstance.status == InstanceStatus.running,
                # 先在库里筛掉压根没配超时的单（绝大多数），不必每 5 分钟把全部在办待办连同快照都拉回来
                WfInstance.model_snapshot.contains('"timeout"'),
            )
        )
    ).all()
    out = []
    models: dict[str, dict[str, Any]] = {}
    for task, snap in rows:
        model = models.setdefault(snap, json.loads(snap))
        due = due_time(task, model)
        if due is not None and due <= now:
            out.append((task.instance_id, task.id))
    return out


async def handle_timeouts(session_maker: Callable[[], Any], *, now: datetime | None = None) -> dict[str, int]:
    """扫一遍、逐条处理。返回 `{remind, approve, reject, skipped}` 计数（给任务日志）"""
    now = now or timezone.now()
    counts = {'remind': 0, 'approve': 0, 'reject': 0, 'skipped': 0}
    async with session_maker() as db:
        candidates = await _candidates(db, now)
    for instance_id, task_id in candidates:
        async with session_maker() as db:
            try:
                done = await apply_timeout(db, instance_id, task_id, now)
            except RetryLater:
                done = None  # 正好有人在办这张单：下一轮再看
            except Exception as e:
                # 一张单出错不能让后面的单都不处理
                log.error(f'审批超时处理失败（实例 {instance_id}，待办 {task_id}）：{e!s}')
                done = None
        counts[done or 'skipped'] += 1
    return counts
