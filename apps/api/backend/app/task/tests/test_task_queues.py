"""长任务单独排队（#400）

`celery_aio_pool.AsyncIOPool` 一个 worker 进程一次只跑一个任务（solo 池子类，`limit = 1`，`run()` 同步等结果），
`--concurrency` 不起作用。长任务和心跳 / 投递挤在一条队列上，一次 AI 预审就能把心跳堵过 180 秒阈值。
修法是按任务名分两条队列、两个 worker 各消费一条（`celery.py: LONG_TASKS`）。

这里钉住三件事：路由表把每个任务送到该去的队列（三种派发路径都只拿得到名字）·
每个注册的任务都被归过类（新任务漏归类会红）· 长任务 worker 才写长任务心跳。

⚠️ 没配 pytest-asyncio，异步的部分在同步测试里自己起循环（同 `test_task_timeout.py`）。
"""

import asyncio
import threading
import time

from types import SimpleNamespace

import pytest

from backend.app.task import celery as celery_module
from backend.app.task.celery import DEFAULT_QUEUE, LONG_QUEUE, celery_app
from backend.plugin.workflow.service.ai_review_service import TASK_NAME as AI_REVIEW_TASK

#: 会跑很久的：导出（大表）· AI 预审（超时 300 秒）· 维护类清理（首次可能删几百万行，上限 1800 秒）
LONG = {
    'export.run',
    AI_REVIEW_TASK,
    'maintenance.prune_logs',
    'maintenance.prune_task_results',
    'maintenance.purge_expired_exports',
    'maintenance.purge_recycled_files',
    'maintenance.purge_stale_multipart',
}
#: 短而要准点的：心跳 · 通知 / Webhook 投递 · 审批超时 · 公告对时 · 每日问候
SHORT = {
    'health.heartbeat',
    'notification.deliver_pending',
    'open.webhook_deliver_pending',
    'workflow.handle_timeouts',
    'notice.sync_inbox',
    'notification.send_daily_greeting',
}


def _queue_of(name: str, **options: object) -> str:
    routed = celery_app.amqp.router.route(dict(options), name)
    return routed['queue'].name


def _registered() -> set[str]:
    # autodiscover 是惰性的，不导入就拿不全（task 分册「高频任务的两条纪律」那条 ⚠️）
    celery_app.loader.import_default_modules()
    return {name for name in celery_app.tasks if not name.startswith('celery.')}


@pytest.mark.parametrize('name', sorted(LONG))
def test_long_tasks_go_to_the_long_queue(name: str) -> None:
    assert _queue_of(name) == LONG_QUEUE


@pytest.mark.parametrize('name', sorted(SHORT))
def test_short_tasks_stay_on_the_default_queue(name: str) -> None:
    assert _queue_of(name) == DEFAULT_QUEUE


def test_every_registered_task_is_classified() -> None:
    """新加的任务必须先想清楚它长不长 —— 两边都没写就红，而不是悄悄落进默认队列和心跳抢 worker"""
    registered = _registered()
    assert LONG.isdisjoint(SHORT)
    assert registered == LONG | SHORT, (
        f'没归类的任务：{sorted(registered - LONG - SHORT)}；归类了却不存在的：{sorted((LONG | SHORT) - registered)}'
    )


def test_a_schedule_without_a_queue_does_not_override_the_route() -> None:
    """beat 和「立即执行」把调度那一行的 `queue` 原样传进来，种子里都是 None —— None 不能把路由表盖掉"""
    assert _queue_of('export.run', queue=None) == LONG_QUEUE


def test_an_explicit_queue_on_a_schedule_still_wins() -> None:
    """管理员在调度上显式填了队列，就按他填的走（celery 的 options 优先于路由表）"""
    assert _queue_of('maintenance.prune_logs', queue='custom') == 'custom'


# ── 长任务 worker 的心跳 ────────────────────────────────────────────────────


class _ThreadLoop:
    """仿 AsyncIOPool：独立线程里 `run_forever()` 的循环"""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        async def cancel_all() -> None:
            tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

        asyncio.run_coroutine_threadsafe(cancel_all(), self.loop).result(2)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(2)
        self.loop.close()


def _sender(*queues: str, loop: asyncio.AbstractEventLoop | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        pool=SimpleNamespace(loop=loop),
        task_consumer=SimpleNamespace(queues=[SimpleNamespace(name=q) for q in queues]),
    )


@pytest.fixture
def heartbeat_writes(monkeypatch) -> list[str]:
    from backend.database.redis import redis_client

    writes: list[str] = []

    async def fake_set(key: str, value: str) -> None:  # ruff: ignore[unused-async] —— 顶替的是协程
        writes.append(key)

    monkeypatch.setattr(redis_client, 'set', fake_set)
    monkeypatch.setattr(celery_module, '_long_heartbeat', None)
    return writes


def test_the_long_worker_writes_its_heartbeat_on_the_pool_loop(heartbeat_writes) -> None:
    pool = _ThreadLoop()
    try:
        celery_module.start_long_queue_heartbeat(sender=_sender(LONG_QUEUE, loop=pool.loop))
        deadline = time.monotonic() + 2
        while not heartbeat_writes and time.monotonic() < deadline:
            time.sleep(0.01)
        assert heartbeat_writes, '长任务 worker 起来了，心跳一次都没写'
        assert set(heartbeat_writes) == {celery_module.settings.LONG_WORKER_HEARTBEAT_REDIS_KEY}
    finally:
        pool.close()


def test_a_default_only_worker_does_not_pretend_to_be_the_long_worker(heartbeat_writes) -> None:
    """🔴 只起了默认 worker 时长任务心跳必须是空的 —— 否则没人消费长任务队列，健康检查照样全绿"""
    pool = _ThreadLoop()
    try:
        celery_module.start_long_queue_heartbeat(sender=_sender(DEFAULT_QUEUE, loop=pool.loop))
        time.sleep(0.2)
        assert heartbeat_writes == []
        assert celery_module._long_heartbeat is None
    finally:
        pool.close()


def test_a_heartbeat_write_failure_does_not_stop_the_heartbeat(monkeypatch) -> None:
    """Redis 抖一下：这一拍写不进，下一拍照写 —— 协程退出了就永远 stale"""
    from backend.database.redis import redis_client

    calls: list[int] = []

    async def flaky_set(key: str, value: str) -> None:  # ruff: ignore[unused-async]
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionError('boom')

    monkeypatch.setattr(redis_client, 'set', flaky_set)
    monkeypatch.setattr(celery_module, 'LONG_WORKER_HEARTBEAT_SECONDS', 0.01)

    async def go() -> None:
        task = asyncio.create_task(celery_module._long_queue_heartbeat())
        await asyncio.sleep(0.1)
        task.cancel()

    asyncio.run(go())
    assert len(calls) >= 2, f'第一拍失败之后心跳停了：{len(calls)} 次'
