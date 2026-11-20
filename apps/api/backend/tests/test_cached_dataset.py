"""进程内全局数据集（`common/cache/dataset.py`）：命中 · 过期 · 加载期间失效 · 提交后才失效。

每一条对应一种静默出错的方式：旧数据被钉进缓存、回滚了也清缓存、过期了不重载。
纯内存那几条用 `asyncio.run`（不碰 Redis，见 tests 分册「不要 asyncio.run」的前提）；
要数据库的两条每次新建独立引擎，发布订阅打桩成记录调用。
"""

import asyncio
import time

import pytest

from backend.common.cache import dataset as dataset_module
from backend.common.cache.dataset import CachedDataset
from backend.common.cache.local import local_cache_manager
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url


class _Loader:
    """记录被调了几次；`during` 在加载过程中执行（模拟加载期间别处提交并失效）"""

    def __init__(self, during=None) -> None:
        self.calls = 0
        self.during = during

    async def __call__(self, db) -> dict:
        self.calls += 1
        if self.during:
            self.during()
        return {'version': self.calls}


@pytest.fixture
def name(request: pytest.FixtureRequest):
    value = f'pytest-{request.node.name}'
    yield value
    local_cache_manager.delete(f'fba:dataset:{value}')


def test_a_hit_does_not_load_again(name: str) -> None:
    loader = _Loader()
    ds = CachedDataset(name, loader)
    first = asyncio.run(ds.get(None))
    second = asyncio.run(ds.get(None))
    assert loader.calls == 1
    assert second is first


def test_an_expired_entry_is_reloaded(name: str) -> None:
    loader = _Loader()
    ds = CachedDataset(name, loader, ttl=0.05)
    asyncio.run(ds.get(None))
    time.sleep(0.1)
    assert asyncio.run(ds.get(None))['version'] == 2


def test_invalidated_while_loading_is_not_stored(name: str) -> None:
    """🔴 读到旧行 → 别处提交并失效 → 把旧行写进缓存：旧数据会被钉住一个 TTL"""
    ds = CachedDataset(name, _Loader())
    ds._loader = _Loader(during=ds.invalidate_now)
    assert asyncio.run(ds.get(None))['version'] == 1, '这一次请求照样拿到加载结果'
    ds._loader.during = None
    assert asyncio.run(ds.get(None))['version'] == 2, '加载期间被失效过，上一次的结果不该进缓存'


def test_a_pubsub_delete_forces_a_reload(name: str) -> None:
    """其他 worker 的失效经发布订阅到达时，监听器做的就是 `local_cache_manager.delete(key)`"""
    ds = CachedDataset(name, _Loader())
    asyncio.run(ds.get(None))
    local_cache_manager.delete(ds.key)
    assert asyncio.run(ds.get(None))['version'] == 2


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """发布订阅打桩：记下发了哪些失效，不碰共享的 Redis 客户端"""
    calls: list[str] = []

    async def fake_publish(key: str, *, delete_by_prefix: bool) -> None:
        await asyncio.sleep(0)
        calls.append(key)

    monkeypatch.setattr(dataset_module.cache_pubsub_manager, 'publish_invalidation', fake_publish)
    return calls


def _in_transaction(ds: CachedDataset, *, rollback: bool) -> dict:
    """在一个真事务里登记失效；返回提交 / 回滚前后缓存还在不在"""

    async def run() -> dict:
        engine = create_database_async_engine(get_database_url(unittest=True))
        seen: dict = {}
        try:
            await ds.get(None)
            try:
                async with create_database_async_session(engine).begin() as db:
                    ds.invalidate_after_commit(db)
                    await asyncio.sleep(0)
                    seen['before_end'] = local_cache_manager.get(ds.key) is not None
                    if rollback:
                        raise RuntimeError('回滚')
            except RuntimeError:
                pass
            for _ in range(5):
                await asyncio.sleep(0)
            seen['after_end'] = local_cache_manager.get(ds.key) is not None
        finally:
            await engine.dispose()
        return seen

    return asyncio.run(run())


def test_invalidation_waits_for_the_commit(name: str, published: list[str]) -> None:
    """🔴 提交之前就清的话，并发请求读到旧行、写回缓存，之后没人再清"""
    ds = CachedDataset(name, _Loader())
    seen = _in_transaction(ds, rollback=False)
    assert seen['before_end'], '还没提交就被清了'
    assert not seen['after_end'], '提交之后应当清掉'
    assert published == [ds.key], '提交之后要通知其他 worker'


def test_a_rollback_does_not_invalidate(name: str, published: list[str]) -> None:
    ds = CachedDataset(name, _Loader())
    seen = _in_transaction(ds, rollback=True)
    assert seen['before_end']
    assert seen['after_end'], '回滚了不该清'
    assert published == []
