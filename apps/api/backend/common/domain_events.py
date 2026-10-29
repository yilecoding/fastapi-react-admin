"""业务事件出口（#167）：service 层在**提交之前**调 `emit(db, 'dept.updated', ...)`。

现在唯一的订阅方是能力开放的 Webhook（`plugin/open`）：它在同一个事务里写一行事件 + 按订阅 fan-out 成投递行，
提交之后 worker 签名 POST 出去。业务回滚就一起没了，不会出现「部门没改成、对方先收到了」。

为什么在 service 层而不是从操作日志派生：HTTP 层不知道一个 `PUT /users/1` 改了什么；审批超时在 Celery 里发生、
AI 工具的写操作也走 service —— **只有 service 层看得全**。

🔴 漏调一处 = 这类变更不发事件，而且是静默的。新加「会改用户 / 部门 / 审批实例状态」的写路径时，记得在这里出口。
插件没装（`plugin/open` 被删掉）时这里什么都不做。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from backend.plugin.core import check_plugin_installed

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


async def emit(db: AsyncSession, type: str, *, aggregate_id: int | None, data: dict[str, Any]) -> None:
    """记一个业务事件。不 commit；调用方的事务提交了，事件才算发生"""
    if not check_plugin_installed('open'):
        return
    from backend.plugin.open.service.event_service import record_event

    await record_event(db, type, aggregate_id=aggregate_id, data=data)
