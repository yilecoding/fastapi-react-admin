"""限流 bucket 在 Redis 丢了脚本缓存之后要能自愈（真实 Redis）。

实测（2026-11-06）：WSL 里的 Redis 重启后，验证码接口每次都 500「No matching script. Please use EVAL.」，
谁都登录不了，直到重启 api。`RedisBucket` 创建时 `SCRIPT LOAD` 一次、之后一直 `EVALSHA`，
而 bucket 缓存在进程里、有请求就不淘汰。`SCRIPT FLUSH` 和 Redis 重启对脚本缓存是同一个效果。
"""

import asyncio
import uuid

from pyrate_limiter import Duration, Rate, RateItem

from backend.database.redis import RedisCli
from backend.utils.limiter import RedisTimeBucket


def test_bucket_reloads_script_after_flush() -> None:
    async def scenario() -> list[bool]:
        client = RedisCli()
        key = f'fba:test:limiter:{uuid.uuid4().hex}'
        try:
            bucket = await RedisTimeBucket.init(rates=[Rate(100, Duration.MINUTE)], redis=client, bucket_key=key)
            first = await bucket.put(RateItem('a', await bucket.now()))
            await client.script_flush()
            # 修复前：这里抛 NoScriptError
            second = await bucket.put(RateItem('a', await bucket.now()))
            return [first, second]
        finally:
            await client.delete(key)
            await client.aclose()

    assert asyncio.run(scenario()) == [True, True]
