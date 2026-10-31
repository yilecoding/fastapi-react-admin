"""「调用方提交之后再做一件事」：给提交不在自己手里的写路径用（socket 推送、踢 worker）。

推送 / 踢早于提交到达的话，对面读到的是提交前的状态（铃铛拉到旧的未读数、worker 读不到投递行）；
回滚了就不该做。所以挂在会话的 `after_commit` 上，`after_rollback` 清掉。

- 同一个会话、同一个 `key` 只做一次（一个事务里广播了两次也只推一次）
- `factory` 在提交那一刻才调，所以测试里 monkeypatch 掉的模块级函数照样生效
- 提交后派出去的协程要留引用：只靠 `create_task` 的话可能被 GC 回收掉

调用方：通知广播的推送（`push_broadcast_after_commit`）· 通知投递踢 worker（`delivery_service.kick_after_commit`）·
Webhook 投递踢 worker（`plugin/open/service/event_service.py: kick_after_commit`，#190 迁过来的）。

⚠️ `app/task/model/scheduler.py` 的变更标记是同形状的另一份，**刻意不迁**：它挂在 beat / 接口的**同步**会话
（`Session`）上、提交后要做的是一次同步的 Redis 写，这里派的是协程（要有正在跑的事件循环）。
"""

import asyncio

from collections.abc import Awaitable, Callable

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

_PENDING = 'after_commit_pending'
_LISTENING = 'after_commit_listening'
_background: set[asyncio.Task[None]] = set()


def run_after_commit(db: AsyncSession, key: str, factory: Callable[[], Awaitable[None]]) -> None:
    """登记一件提交之后要做的事。没有正在跑的事件循环时（同步上下文提交）不做"""
    sync: Session = db.sync_session
    sync.info.setdefault(_PENDING, {})[key] = factory
    if sync.info.get(_LISTENING):
        return
    sync.info[_LISTENING] = True
    sa_event.listen(sync, 'after_commit', _on_commit)
    sa_event.listen(sync, 'after_rollback', _on_rollback)


def _on_commit(session: Session) -> None:
    pending: dict[str, Callable[[], Awaitable[None]]] | None = session.info.pop(_PENDING, None)
    if not pending:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for factory in pending.values():
        task = loop.create_task(factory())  # type: ignore[arg-type]
        _background.add(task)
        task.add_done_callback(_background.discard)


def _on_rollback(session: Session) -> None:
    session.info.pop(_PENDING, None)
