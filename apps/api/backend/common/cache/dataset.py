"""全局、少变的数据集（菜单表这种）：进程内缓存 + 提交后跨进程失效 + 短 TTL 兜底。

为什么要有它：侧边栏、菜单树、超管权限码每个请求都把整张菜单表读一遍、建一遍 ORM 对象，
而菜单一天也改不了几次。压测里侧边栏是按调用频率加权最贵的接口之一（见 `scripts/AGENTS.md`）。

三条设计，每条都对应一种静默出错的方式：

1. **只放进程内存，不放 Redis。** 菜单也会被**不经过服务层**的路径改：数据库迁移、`fba` 命令行装插件。
   这些路径都要求重启服务，进程内缓存随重启清空；放进 Redis 的话，旧数据会熬过重启，迁移改了菜单、界面上还是旧的。
2. **失效挂在「提交之后」**（`run_after_commit`），本进程当场清，其他 worker 经发布订阅清。
   在提交之前清的话，并发请求读到旧行、再写回缓存，之后再没有人清（`UserCacheManager` 那条 #34 的坑）。
3. **加载期间收到失效，这次加载的结果不进缓存。** 加载前放一个占位对象，加载完只有占位还在才写入。
   否则「读到旧行 → 别处提交并清缓存 → 把旧行写进缓存」这个窗口会把旧数据钉住一个 TTL。

⚠️ TTL 是兜底，不是主要的失效手段：发布订阅的监听器连续重连失败 10 次会**永久停止**（`pubsub.py`），
之后别的 worker 的失效通知都收不到，只能等 TTL。所以 TTL 要短（默认 60 秒）。
"""

import time

from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.after_commit import run_after_commit
from backend.common.cache.local import local_cache_manager
from backend.common.cache.pubsub import cache_pubsub_manager
from backend.core.conf import settings

T = TypeVar('T')


class _Loading:
    """占位：这个 key 正在加载。失效会把它删掉，加载完发现它不在了就不写入"""


class CachedDataset(Generic[T]):
    """一份全局数据集的进程内缓存

    :param name: 数据集名，拼成缓存键 `fba:dataset:<name>`
    :param loader: 用调用方的会话把整份数据读出来；返回值会被所有请求共享，**调用方不得原地修改**
    :param ttl: 兜底过期秒数
    """

    def __init__(self, name: str, loader: Callable[[AsyncSession], Awaitable[T]], *, ttl: float = 60.0) -> None:
        self.name = name
        self.key = f'{settings.CACHE_DATASET_PREFIX}:{name}'
        self._loader = loader
        self._ttl = ttl

    async def get(self, db: AsyncSession) -> T:
        """取数据集：命中且没过期直接返回，否则用 `db` 加载一次"""
        if settings.CACHE_LOCAL_ENABLED:
            entry = local_cache_manager.get(self.key)
            if isinstance(entry, tuple) and entry[0] > time.monotonic():
                return entry[1]

        marker = _Loading()
        if settings.CACHE_LOCAL_ENABLED:
            local_cache_manager.set(self.key, marker)
        value = await self._loader(db)
        if settings.CACHE_LOCAL_ENABLED and local_cache_manager.get(self.key) is marker:
            local_cache_manager.set(self.key, (time.monotonic() + self._ttl, value))
        return value

    def invalidate_now(self) -> None:
        """只清本进程（测试、启动时用）"""
        local_cache_manager.delete(self.key)

    async def _invalidate_everywhere(self) -> None:
        self.invalidate_now()
        await cache_pubsub_manager.publish_invalidation(self.key, delete_by_prefix=False)

    def invalidate_after_commit(self, db: AsyncSession) -> None:
        """登记：这个会话提交之后，本进程和其他 worker 都清掉这份数据集；回滚了就不清"""
        run_after_commit(db, f'dataset:{self.name}', self._invalidate_everywhere)
