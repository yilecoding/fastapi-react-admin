import asyncio

import pytest

from backend.common.exception import errors
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
