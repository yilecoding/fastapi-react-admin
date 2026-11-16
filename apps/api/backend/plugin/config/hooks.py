"""停止缓存原始配置后，启动时清理旧版本可能留下的明文缓存。"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from backend.common.cache.decorator import invalidate_cache
from backend.core.conf import settings


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    await invalidate_cache(settings.CACHE_CONFIG_REDIS_PREFIX, prefix=True)
    yield
