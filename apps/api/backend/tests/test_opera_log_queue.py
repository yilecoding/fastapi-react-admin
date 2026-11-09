"""操作日志队列：关停时排空、满了丢弃不卡请求（上游 10791a1 的思路，按本仓库的代码重写）

两个修之前实测过的失败：

- 关停时直接 `cancel()` 消费者：入队 3 条，写进去 0 条，队列也空了 —— 那一批在消费者手里被一起丢掉
- 满队列上 `await put()`：1 秒内不返回，业务请求跟着挂住
"""

import asyncio

from collections.abc import Generator

import pytest

from backend.common.queue import batch_consume
from backend.core.conf import settings
from backend.middleware.opera_log_middleware import OperaLogMiddleware


def test_stop_drains_the_batch_already_in_hand() -> None:
    """消费者已经把 3 条攥在手里、正在等凑满一批（超时 60 秒）时置位停止：3 条都要写进去"""

    async def scenario() -> list[int]:
        queue: asyncio.Queue[int] = asyncio.Queue()
        written: list[int] = []
        stop = asyncio.Event()

        async def handler(items: list[int]) -> None:
            await asyncio.sleep(0)  # batch_consume 会 await 它，必须是协程
            written.extend(items)

        task = asyncio.create_task(batch_consume(queue, max_items=100, timeout=60, handler=handler, stop_event=stop))
        for i in range(3):
            queue.put_nowait(i)
        await asyncio.sleep(0.1)
        assert written == [], '前提：还没凑满一批，也没到超时，应该一条都没写'
        stop.set()
        await asyncio.wait_for(task, timeout=3)
        return written

    assert asyncio.run(scenario()) == [0, 1, 2]


def test_stop_also_drains_items_still_in_queue() -> None:
    """队列里的比一批多：停止后分几批全部写完再退出"""

    async def scenario() -> tuple[list[int], list[int]]:
        queue: asyncio.Queue[int] = asyncio.Queue()
        batches: list[int] = []
        written: list[int] = []
        stop = asyncio.Event()

        async def handler(items: list[int]) -> None:
            await asyncio.sleep(0)  # batch_consume 会 await 它，必须是协程
            batches.append(len(items))
            written.extend(items)

        for i in range(250):
            queue.put_nowait(i)
        stop.set()
        await asyncio.wait_for(
            batch_consume(queue, max_items=100, timeout=60, handler=handler, stop_event=stop), timeout=3
        )
        return batches, written

    batches, written = asyncio.run(scenario())
    assert batches == [100, 100, 50]
    assert written == list(range(250))


def test_idle_consumer_stops_without_waiting_for_the_batch_timeout() -> None:
    """队列是空的：停止要在几秒内生效，不能等满 60 秒的批次超时"""

    async def scenario() -> float:
        queue: asyncio.Queue[int] = asyncio.Queue()
        stop = asyncio.Event()

        async def handler(items: list[int]) -> None:
            await asyncio.sleep(0)  # batch_consume 会 await 它，必须是协程
            raise AssertionError('空队列不该调用 handler')

        task = asyncio.create_task(batch_consume(queue, max_items=100, timeout=60, handler=handler, stop_event=stop))
        await asyncio.sleep(0.05)
        loop = asyncio.get_running_loop()
        start = loop.time()
        stop.set()
        await asyncio.wait_for(task, timeout=5)
        return loop.time() - start

    assert asyncio.run(scenario()) < 2.5


@pytest.fixture
def small_opera_log_queue() -> Generator[None, None, None]:
    original_queue = OperaLogMiddleware.opera_log_queue
    original_timeout = settings.OPERA_LOG_QUEUE_DRAIN_TIMEOUT
    OperaLogMiddleware._last_full_warn = 0.0
    OperaLogMiddleware._dropped_since_warn = 0
    try:
        yield
    finally:
        OperaLogMiddleware.opera_log_queue = original_queue
        settings.OPERA_LOG_QUEUE_DRAIN_TIMEOUT = original_timeout
        OperaLogMiddleware.opera_log_stop_event.clear()


@pytest.mark.usefixtures('small_opera_log_queue')
def test_enqueue_drops_instead_of_blocking_when_full() -> None:
    OperaLogMiddleware.opera_log_queue = asyncio.Queue(maxsize=1)

    assert OperaLogMiddleware.enqueue('第一条') is True  # type: ignore[arg-type]
    assert OperaLogMiddleware.enqueue('第二条') is False  # type: ignore[arg-type]
    assert OperaLogMiddleware.opera_log_queue.qsize() == 1


@pytest.mark.usefixtures('small_opera_log_queue')
def test_stop_consumer_drains_then_returns() -> None:
    async def scenario() -> list[int]:
        queue: asyncio.Queue[int] = asyncio.Queue()
        OperaLogMiddleware.opera_log_queue = queue
        OperaLogMiddleware.opera_log_stop_event.clear()
        written: list[int] = []

        async def handler(items: list[int]) -> None:
            await asyncio.sleep(0)  # batch_consume 会 await 它，必须是协程
            written.extend(items)

        task = asyncio.create_task(
            batch_consume(
                queue, max_items=100, timeout=60, handler=handler, stop_event=OperaLogMiddleware.opera_log_stop_event
            )
        )
        for i in range(3):
            queue.put_nowait(i)
        await asyncio.sleep(0.1)
        await OperaLogMiddleware.stop_consumer(task)
        assert task.done()
        return written

    assert asyncio.run(scenario()) == [0, 1, 2]


@pytest.mark.usefixtures('small_opera_log_queue')
def test_stop_consumer_gives_up_after_drain_timeout() -> None:
    """入库卡死（比如数据库不响应）时，关停最多等 OPERA_LOG_QUEUE_DRAIN_TIMEOUT，不能把进程挂住"""
    settings.OPERA_LOG_QUEUE_DRAIN_TIMEOUT = 0.3  # type: ignore[assignment]

    async def scenario() -> tuple[float, bool]:
        queue: asyncio.Queue[int] = asyncio.Queue()
        OperaLogMiddleware.opera_log_queue = queue
        OperaLogMiddleware.opera_log_stop_event.clear()

        async def handler(items: list[int]) -> None:
            await asyncio.sleep(3600)

        task = asyncio.create_task(
            batch_consume(
                queue, max_items=1, timeout=60, handler=handler, stop_event=OperaLogMiddleware.opera_log_stop_event
            )
        )
        queue.put_nowait(1)
        await asyncio.sleep(0.05)
        loop = asyncio.get_running_loop()
        start = loop.time()
        await OperaLogMiddleware.stop_consumer(task)
        return loop.time() - start, task.done()

    elapsed, done = asyncio.run(scenario())
    assert elapsed < 1.5
    assert done
