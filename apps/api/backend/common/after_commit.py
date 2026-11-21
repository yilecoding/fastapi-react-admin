"""「调用方提交之后再做一件事」：给提交不在自己手里的写路径用（socket 推送、踢 worker）。

推送 / 踢早于提交到达的话，对面读到的是提交前的状态（铃铛拉到旧的未读数、worker 读不到投递行）；
回滚了就不该做。所以挂在会话的 `after_commit` 上，`after_soft_rollback` 清掉。

- 同一个会话、同一个 `key` 只做一次（一个事务里广播了两次也只推一次）
- `factory` 在提交那一刻才调，所以测试里 monkeypatch 掉的模块级函数照样生效
- 提交后派出去的协程要留引用：只靠 `create_task` 的话可能被 GC 回收掉

调用方：通知广播的推送（`push_broadcast_after_commit`）· 通知投递踢 worker（`delivery_service.kick_after_commit`）·
Webhook 投递踢 worker（`plugin/open/service/event_service.py: kick_after_commit`，#190 迁过来的）。

🔴 **只认最外层的提交 / 回滚（#394）。** SQLAlchemy 2.0 的保存点（`begin_nested()`）释放 / 回滚也会派发
`after_commit` / `after_rollback`（`SessionTransaction.commit`：`if self._parent is None or self.nested`），
同目录 `data_change/capture.py` 是同一个判断。不区分的话：保存点里登记的在保存点**释放**时就派发（外层还没提交，
worker 读不到投递行；外层随后回滚也已经发出去）；外层早先登记的被一次保存点回滚**整个**丢掉。
所以每件待办记下「登记时最内层的保存点」：保存点释放 → 过继给上一层；保存点回滚 → 只丢它（和它里面的）登记的；
最外层提交才派发、最外层回滚全丢。

⚠️ `app/task/model/scheduler.py` 的变更标记是同形状的另一份，**刻意不迁**：它挂在 beat / 接口的**同步**会话
（`Session`）上、提交后要做的是一次同步的 Redis 写，这里派的是协程（要有正在跑的事件循环）。
"""

import asyncio

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from sqlalchemy import event as sa_event
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session, SessionTransaction

_PENDING = 'after_commit_pending'
_LISTENING = 'after_commit_listening'
_background: set[asyncio.Task[None]] = set()


@dataclass(slots=True)
class _Pending:
    factory: Callable[[], Awaitable[None]]
    #: 登记时最内层的保存点；None = 外层事务本身
    owner: SessionTransaction | None


def run_after_commit(db: AsyncSession, key: str, factory: Callable[[], Awaitable[None]]) -> None:
    """登记一件提交之后要做的事。没有正在跑的事件循环时（同步上下文提交）不做"""
    sync: Session = db.sync_session
    pending: dict[str, _Pending] = sync.info.setdefault(_PENDING, {})
    existing = pending.get(key)
    # 同一个 key 早先（在更外层）登记过：留着那一层 —— 不然一次保存点回滚会把外层那份一起带走
    owner = existing.owner if existing is not None else sync.get_nested_transaction()
    pending[key] = _Pending(factory, owner)
    if sync.info.get(_LISTENING):
        return
    sync.info[_LISTENING] = True
    sa_event.listen(sync, 'after_commit', _on_commit)
    sa_event.listen(sync, 'after_soft_rollback', _on_rollback)


def _enclosing_savepoint(transaction: SessionTransaction) -> SessionTransaction | None:
    parent = transaction.parent
    while parent is not None and not parent.nested:
        parent = parent.parent
    return parent


def _within(owner: SessionTransaction | None, savepoint: SessionTransaction) -> bool:
    while owner is not None:
        if owner is savepoint:
            return True
        owner = owner.parent
    return False


def _on_commit(session: Session) -> None:
    pending: dict[str, _Pending] | None = session.info.get(_PENDING)
    if not pending:
        return
    if session.in_nested_transaction():
        # 保存点释放（派发时它还是当前事务）：它名下的过继给上一层，等最外层提交
        savepoint = session.get_nested_transaction()
        assert savepoint is not None
        parent = _enclosing_savepoint(savepoint)
        for item in pending.values():
            if item.owner is savepoint:
                item.owner = parent
        return
    session.info.pop(_PENDING, None)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    for item in pending.values():
        task = loop.create_task(item.factory())  # type: ignore[arg-type]
        _background.add(task)
        task.add_done_callback(_background.discard)


def _on_rollback(session: Session, previous_transaction: SessionTransaction) -> None:
    if previous_transaction.nested:
        pending: dict[str, _Pending] | None = session.info.get(_PENDING)
        if pending:
            for key in [k for k, item in pending.items() if _within(item.owner, previous_transaction)]:
                del pending[key]
    elif previous_transaction.parent is None:
        session.info.pop(_PENDING, None)
