"""热重载锁等不到时要报错，不能当作拿到了往下走（上游 7ab3bb8 的同类问题）

redis-py 的 `Lock.acquire()` 等满 `blocking_timeout` 返回 False、不抛异常；原来没看返回值。
"""

import asyncio

from pathlib import Path

import pytest

from backend.common.exception import errors
from backend.utils import locks


class _FakeLock:
    def __init__(self, *, acquired: bool) -> None:
        self.acquired = acquired
        self.released = False

    async def acquire(self) -> bool:
        return self.acquired

    async def owned(self) -> bool:
        return self.acquired

    async def release(self) -> None:
        self.released = True


def _use_fake_lock(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, lock: _FakeLock) -> Path:
    monkeypatch.setattr(locks.redis_client, 'lock', lambda *args, **kwargs: lock)
    lock_file = tmp_path / 'reload.lock'
    monkeypatch.setattr(locks, 'RELOAD_LOCK_FILE', lock_file)
    return lock_file


def test_lock_not_acquired_raises_conflict_and_touches_nothing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lock = _FakeLock(acquired=False)
    lock_file = _use_fake_lock(monkeypatch, tmp_path, lock)
    entered = False

    async def scenario() -> None:
        nonlocal entered
        async with locks.acquire_distributed_reload_lock():
            entered = True

    with pytest.raises(errors.ConflictError):
        asyncio.run(scenario())
    assert not entered
    assert not lock_file.exists()


def test_lock_acquired_runs_body_and_releases(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lock = _FakeLock(acquired=True)
    lock_file = _use_fake_lock(monkeypatch, tmp_path, lock)
    seen_file_during_body = False

    async def scenario() -> None:
        nonlocal seen_file_during_body
        async with locks.acquire_distributed_reload_lock():
            seen_file_during_body = lock_file.exists()

    asyncio.run(scenario())
    assert seen_file_during_body
    assert not lock_file.exists()
    assert lock.released
