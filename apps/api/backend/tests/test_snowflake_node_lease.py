import asyncio
import threading
import time

from types import SimpleNamespace

import pytest

from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.utils.snowflake import Snowflake, SnowflakeNodeManager


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.expirations: dict[str, int] = {}

    async def scan_iter(self, *, match: str):
        prefix = match.removesuffix('*')
        for key in self.values:
            if key.startswith(prefix):
                yield key

    async def set(self, key: str, value: str, *, nx: bool, ex: int) -> bool:
        if nx and key in self.values:
            return False
        self.values[key] = value
        self.expirations[key] = ex
        return True

    async def eval(self, script: str, numkeys: int, key: str, token: str, *args: str) -> int:
        assert numkeys == 1
        if 'EXPIRE' in script:
            ttl = int(args[0])
            if self.values.get(key) == token:
                self.expirations[key] = ttl
                return 1
            if key not in self.values:
                self.values[key] = token
                self.expirations[key] = ttl
                return 2
            return 0
        if self.values.get(key) == token:
            del self.values[key]
            self.expirations.pop(key, None)
            return 1
        return 0

    async def delete(self, key: str) -> int:
        return int(self.values.pop(key, None) is not None)


def test_heartbeat_reclaims_a_missing_lease(monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        redis = FakeRedis()
        manager = SnowflakeNodeManager(redis)  # type: ignore[arg-type]
        monkeypatch.setattr(settings, 'SNOWFLAKE_NODE_TTL_SECONDS', 60)
        key = f'{manager.node_redis_prefix}:0:0'
        assert await manager._register(0, 0)
        assert await manager._renew_lease(key) == 1
        assert redis.expirations[key] == 60

        await redis.delete(key)
        renewed = await manager._renew_lease(key)

        assert renewed == 2
        assert redis.values[key] == manager._node_token
        assert redis.expirations[key] == 60
        assert manager.lease_valid

    asyncio.run(scenario())


def test_heartbeat_stops_generator_when_another_process_owns_the_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def scenario() -> None:
        redis = FakeRedis()
        manager = SnowflakeNodeManager(redis)  # type: ignore[arg-type]
        monkeypatch.setattr(settings, 'SNOWFLAKE_NODE_TTL_SECONDS', 60)
        key = f'{manager.node_redis_prefix}:0:0'
        assert await manager._register(0, 0)
        redis.values[key] = 'other-process-token'

        renewed = await manager._renew_lease(key)
        gen = Snowflake()
        gen.datacenter_id, gen.worker_id = 0, 0
        gen._initialized = True
        gen._auto_allocated = True
        gen._node_manager = manager

        assert renewed == 0
        assert not manager.lease_valid
        with pytest.raises(errors.ServerError):
            gen.generate()

    asyncio.run(scenario())


def test_release_does_not_delete_a_reassigned_lease() -> None:
    async def scenario() -> None:
        redis = FakeRedis()
        manager = SnowflakeNodeManager(redis)  # type: ignore[arg-type]
        key = f'{manager.node_redis_prefix}:0:0'
        await redis.set(key, 'other-process-token', nx=True, ex=60)
        manager.datacenter_id, manager.worker_id = 0, 0

        await manager.release()

        assert redis.values[key] == 'other-process-token'

    asyncio.run(scenario())


class _FakePool:
    """仿 `celery_aio_pool.AsyncIOPool`：独立线程里 `run_forever()` 的事件循环"""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self._thread.start()

    def close(self, gen: Snowflake) -> None:
        if gen._node_manager is not None:
            asyncio.run_coroutine_threadsafe(gen._node_manager.release(), self.loop).result(timeout=5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self._thread.join(timeout=5)
        self.loop.close()


@pytest.fixture
def short_lease(monkeypatch: pytest.MonkeyPatch) -> Snowflake:
    """动态分配节点 + 1 秒租约 / 0.2 秒心跳，换一个全新的发号器和假 Redis"""
    import backend.utils.snowflake as snowflake_mod

    monkeypatch.setattr(settings, 'DATABASE_PK_MODE', 'snowflake')
    monkeypatch.setattr(settings, 'SNOWFLAKE_DATACENTER_ID', None)
    monkeypatch.setattr(settings, 'SNOWFLAKE_WORKER_ID', None)
    monkeypatch.setattr(settings, 'SNOWFLAKE_NODE_TTL_SECONDS', 1)
    monkeypatch.setattr(settings, 'SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS', 0.2)
    monkeypatch.setattr(snowflake_mod, 'redis_client', FakeRedis())
    gen = Snowflake()
    monkeypatch.setattr(snowflake_mod, 'snowflake', gen)
    return gen


def test_worker_startup_keeps_issuing_ids_past_the_lease_ttl(short_lease: Snowflake) -> None:
    """🔴 #369：按 worker 的起法初始化，超过 TTL 之后仍要能发号

    心跳必须活在任务运行的那个循环（AsyncIOPool 的）上。原来在 `asyncio.run` 的临时循环里起，
    循环一关心跳被取消，启动 60 秒后所有发号都被拒
    """
    from backend.app.task.celery import init_worker_snowflake

    pool = _FakePool()
    try:
        init_worker_snowflake(sender=SimpleNamespace(pool=pool))
        assert short_lease._auto_allocated

        time.sleep(1.6)  # 越过 1 秒的租约期限，中间心跳应该已经续了好几拍

        assert short_lease._node_manager is not None
        assert short_lease._node_manager.lease_valid
        assert short_lease.generate() > 0
    finally:
        pool.close(short_lease)


def test_throwaway_loop_init_loses_the_lease_after_ttl(short_lease: Snowflake) -> None:
    """反例：#369 之前的起法 —— 临时循环里 init，循环关掉心跳就没了

    留着它是为了证明上面那条测试真的测到了点子上；报错要说「租约失效」，不能说「未初始化」
    """
    asyncio.run(short_lease.init())
    time.sleep(1.2)

    with pytest.raises(errors.ServerError) as exc:
        short_lease.generate()
    assert exc.value.msg == t('error.snowflake.lease_lost')
    assert exc.value.msg != t('error.snowflake.generation_failed')


def test_one_failed_heartbeat_does_not_stop_the_generator(monkeypatch: pytest.MonkeyPatch) -> None:
    """一次 Redis 抖动不该让本进程立刻停发 —— Redis 里的租约还剩大半个 TTL，失败后短间隔重试"""
    import backend.utils.snowflake as snowflake_mod

    monkeypatch.setattr(settings, 'SNOWFLAKE_NODE_TTL_SECONDS', 60)
    monkeypatch.setattr(settings, 'SNOWFLAKE_HEARTBEAT_INTERVAL_SECONDS', 0.05)
    monkeypatch.setattr(snowflake_mod, '_HEARTBEAT_RETRY_SECONDS', 0.01)

    class FlakyRedis(FakeRedis):
        def __init__(self) -> None:
            super().__init__()
            self.failures = 1
            self.renewals = 0

        async def eval(self, script: str, numkeys: int, key: str, token: str, *args: str) -> int:
            if 'EXPIRE' in script:
                if self.failures:
                    self.failures -= 1
                    raise ConnectionError('Connection reset by peer')
                self.renewals += 1
            return await super().eval(script, numkeys, key, token, *args)

    async def scenario() -> None:
        redis = FlakyRedis()
        manager = SnowflakeNodeManager(redis)  # type: ignore[arg-type]
        assert await manager._register(0, 0)
        await manager.start_heartbeat(0, 0)
        try:
            await asyncio.sleep(0.06)  # 第一拍抛了异常
            assert redis.failures == 0
            assert manager.lease_valid, '一次心跳失败就判死，会让这个进程一个心跳间隔内写入全挂'
            await asyncio.sleep(0.05)  # 短间隔重试已经续上
            assert redis.renewals >= 1
            assert manager.lease_valid
        finally:
            await manager.release()

    asyncio.run(scenario())
