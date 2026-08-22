"""同步数据库会话 —— 只给 celery beat 用。

🔴 **beat 是同步进程**，而应用主体全栈异步（`aioodbc`）。异步引擎喂不进
beat 的调度循环，所以这里另起一套同步会话。

不是新依赖：SQL Server 走 `pyodbc`，而 `pyodbc` 本来就是 `aioodbc` 的依赖
（实测 venv 里是 5.3.0，ODBC Driver 18 也在）。连接串复用
`celery.py: get_result_backend()`，去掉 celery 加的 `db+` 前缀 ——
让「beat 读调度」和「worker 写结果」永远连同一个库，不会各配一份配错。
"""

from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.app.task.celery import get_result_backend

_engine = None
_factory: sessionmaker[Session] | None = None


def _ensure() -> sessionmaker[Session]:
    global _engine, _factory
    if _factory is None:
        # celery 的 result_backend 要求 `db+` 前缀，SQLAlchemy 不认
        url = get_result_backend().removeprefix('db+')
        _engine = create_engine(url, pool_pre_ping=True, future=True)
        _factory = sessionmaker(_engine, expire_on_commit=False)
    return _factory


@contextmanager
def sync_session() -> Iterator[Session]:
    """给 beat 用的同步会话。异常时回滚，永远关闭。"""
    with _ensure()() as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
