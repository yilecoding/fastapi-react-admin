"""全局、少变的数据集（菜单表这种）：进程内缓存 + 提交后跨进程失效 + 短 TTL 兜底。

为什么要有它：侧边栏、菜单树、超管权限码每个请求都把整张菜单表读一遍、建一遍 ORM 对象，
而菜单一天也改不了几次。压测里侧边栏是按调用频率加权最贵的接口之一（见 `scripts/AGENTS.md`）。

五条设计，每条都对应一种静默出错的方式：

1. **只放进程内存，不放 Redis。** 菜单也会被**不经过服务层**的路径改：数据库迁移、`fba` 命令行装插件。
   这些路径都要求重启服务，进程内缓存随重启清空；放进 Redis 的话，旧数据会熬过重启，迁移改了菜单、界面上还是旧的。
2. **失效挂在「提交之后」**（`run_after_commit`），本进程当场清，其他 worker 经发布订阅清。
   在提交之前清的话，并发请求读到旧行、再写回缓存，之后再没有人清（`UserCacheManager` 那条 #34 的坑）。
3. **加载期间收到失效，这次加载的结果不进缓存。** 加载前放一个占位对象，加载完只有占位还在才写入。
   否则「读到旧行 → 别处提交并清缓存 → 把旧行写进缓存」这个窗口会把旧数据钉住一个 TTL。
4. **同一时刻只有一个请求在加载（单飞），其余等它的结果。** 第一版每个冷请求都放自己的占位、覆盖前一个的，
   先开始的加载完发现占位不是自己的就不写入 —— 并发请求源源不断时缓存**一直填不上**，每个请求都查整张表
   （代码评审抓到的；一个接一个的压测测不出来）。
5. **在调用方的引擎上另开一个会话加载，不借调用方的会话。** 调用方可能在一个改过菜单、还没提交的事务里，
   借它的会话会把未提交的行写进所有请求共享的缓存，事务回滚了也留到 TTL 到期。
   也不能改用全局的 `async_db_session`：引擎要跟着调用方走（测试库、事件循环都是调用方的），
   第一版那样改了之后，在另一个事件循环里调服务的测试跨循环用连接，当场卡死（评审修复时踩到）。

⚠️ TTL 是兜底，不是主要的失效手段：发布订阅的监听器连续重连失败 10 次会**永久停止**（`pubsub.py`），
之后别的 worker 的失效通知都收不到，只能等 TTL。所以 TTL 要短（默认 60 秒）。
"""

import asyncio
import time

from collections.abc import Awaitable, Callable
from typing import Any, Generic, TypeVar

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.after_commit import run_after_commit
from backend.common.cache.local import local_cache_manager
from backend.common.cache.pubsub import cache_pubsub_manager
from backend.core.conf import settings

T = TypeVar('T')


def _retrieve_exception(future: asyncio.Future[Any]) -> None:
    """没有人等的时候，加载失败的异常也算「被取走了」，免得退出时报 never retrieved"""
    if not future.cancelled():
        future.exception()


class _Loading:
    """占位：这个 key 正在加载。等它的请求共用 `future`；失效会把占位删掉，加载完发现它不在了就不写入"""

    def __init__(self) -> None:
        self.future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self.future.add_done_callback(_retrieve_exception)


class CachedDataset(Generic[T]):
    """一份全局数据集的进程内缓存

    :param name: 数据集名，拼成缓存键 `fba:dataset:<name>`
    :param loader: 用给它的会话把整份数据读出来；返回值会被所有请求共享，**调用方不得原地修改**
    :param ttl: 兜底过期秒数
    """

    def __init__(self, name: str, loader: Callable[[AsyncSession], Awaitable[T]], *, ttl: float = 60.0) -> None:
        self.name = name
        self.key = f'{settings.CACHE_DATASET_PREFIX}:{name}'
        self._loader = loader
        self._ttl = ttl

    async def _load(self, db: AsyncSession) -> T:
        # 同一个引擎、另一个会话：看不到调用方事务里没提交的改动，测试库 / 事件循环又和调用方一致
        async with AsyncSession(bind=db.bind, expire_on_commit=False) as fresh:
            return await self._loader(fresh)

    async def get(self, db: AsyncSession) -> T:
        """取数据集：命中且没过期直接返回；有人正在加载就等他的结果；否则自己加载一次"""
        if not settings.CACHE_LOCAL_ENABLED:
            return await self._load(db)

        entry = local_cache_manager.get(self.key)
        if isinstance(entry, tuple) and entry[0] > time.monotonic():
            return entry[1]
        if isinstance(entry, _Loading):
            # shield：等的人被取消（客户端断开）不能把正在进行的那次加载一起取消掉
            return await asyncio.shield(entry.future)

        marker = _Loading()
        local_cache_manager.set(self.key, marker)
        try:
            value = await self._load(db)
        except BaseException as e:
            if not marker.future.done():
                marker.future.set_exception(e)
            if local_cache_manager.get(self.key) is marker:
                local_cache_manager.delete(self.key)
            raise
        marker.future.set_result(value)
        if local_cache_manager.get(self.key) is marker:
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
