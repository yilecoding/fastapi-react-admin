"""连接池参数来自配置（压测里发现原来写死在 `database/db.py`，多 worker 时撞了数据库的连接上限）。"""

import pytest

from backend.core.conf import settings
from backend.database.db import create_database_async_engine


@pytest.mark.parametrize(('size', 'overflow', 'pre_ping'), [(10, 20, True), (3, 0, False)])
def test_engine_pool_follows_settings(
    monkeypatch: pytest.MonkeyPatch, size: int, overflow: int, *, pre_ping: bool
) -> None:
    monkeypatch.setattr(settings, 'DATABASE_POOL_SIZE', size)
    monkeypatch.setattr(settings, 'DATABASE_POOL_MAX_OVERFLOW', overflow)
    monkeypatch.setattr(settings, 'DATABASE_POOL_PRE_PING', pre_ping)
    pool = create_database_async_engine('postgresql+asyncpg://u:p@127.0.0.1:1/x').sync_engine.pool
    assert pool.size() == size
    assert pool._max_overflow == overflow
    assert pool._pre_ping is pre_ping


def test_pool_defaults_are_unchanged() -> None:
    """默认值 10 / 20 / 探活关（2026-11-20 为吞吐改成关，实测代价见 conf.py）

    改默认值是行为变更，要在 Release 里写明
    """
    assert (settings.DATABASE_POOL_SIZE, settings.DATABASE_POOL_MAX_OVERFLOW, settings.DATABASE_POOL_PRE_PING) == (
        10,
        20,
        False,
    )
