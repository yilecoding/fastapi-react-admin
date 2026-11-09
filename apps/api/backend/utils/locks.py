from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

import anyio

from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.path_conf import RELOAD_LOCK_FILE
from backend.database.redis import redis_client


@asynccontextmanager
async def acquire_distributed_reload_lock() -> AsyncGenerator[None, Any]:
    """获取分布式热重载锁"""
    lock = redis_client.lock(
        'fba:reload_lock',
        timeout=300,  # 锁持有超时：5 分钟
        blocking_timeout=60,  # 获取锁等待超时：60 秒
    )
    # 🔴 要看返回值：等满 blocking_timeout 还没拿到时 acquire() 返回 False，**不抛异常**
    # （redis-py 8.1.0）。原来没看，等不到锁也照样往下走，两次插件安装就同时进行了（上游 #1255）
    if not await lock.acquire():
        raise errors.ConflictError(msg=t('error.plugin.reload_lock_busy'))

    # 文件锁（通知文件监控器跳过重载）
    lock_path = anyio.Path(RELOAD_LOCK_FILE)
    await lock_path.touch()

    try:
        yield
    finally:
        await lock_path.unlink(missing_ok=True)
        if await lock.owned():
            await lock.release()
