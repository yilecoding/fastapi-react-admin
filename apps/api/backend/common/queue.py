import asyncio
import time

from asyncio import Queue
from collections.abc import Awaitable, Callable
from typing import TypeVar

from backend.common.log import log
from backend.common.observability.prometheus.queue import (
    inc_queue_exception,
    observe_batch_dequeue_cost,
    observe_queue_size,
)

T = TypeVar('T')

# 等新项目时多久看一次停止信号。不看的话停止要等满一整个批次超时（操作日志是 60 秒）
_STOP_CHECK_INTERVAL = 1.0


async def batch_dequeue(
    queue: Queue[T],
    max_items: int,
    timeout: float,
    *,
    queue_name: str = 'default',
    stop_event: asyncio.Event | None = None,
) -> list[T]:
    """
    从异步队列中获取多个项目

    :param queue: 用于获取项目的 `asyncio.Queue` 队列
    :param max_items: 从队列中获取的最大项目数量
    :param timeout: 总的等待超时时间（秒）
    :param queue_name: 队列名称，用于 Prometheus 标签
    :param stop_event: 停止信号。置位后不再等新项目，只取走队列里已有的
    :return:
    """
    items = []
    start = time.perf_counter()

    async def collector() -> None:
        while len(items) < max_items:
            if stop_event is None:
                item = await queue.get()
            elif stop_event.is_set():
                if queue.empty():
                    return
                item = queue.get_nowait()
            else:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=_STOP_CHECK_INTERVAL)
                except TimeoutError:
                    continue
            items.append(item)
            observe_queue_size(queue, queue_name=queue_name)

    try:
        await asyncio.wait_for(collector(), timeout=timeout)
    except TimeoutError:
        pass
    except Exception as e:
        inc_queue_exception(queue_name=queue_name)
        log.error(f'队列批量获取失败: {e}')
    finally:
        observe_batch_dequeue_cost(start, queue_name=queue_name)
        observe_queue_size(queue, queue_name=queue_name)

    return items


async def batch_consume(
    queue: Queue[T],
    max_items: int,
    timeout: float,
    handler: Callable[..., Awaitable[None]],
    *,
    queue_name: str = 'default',
    error_message: str = '队列批量处理失败',
    item_name: str = '数据',
    stop_event: asyncio.Event | None = None,
) -> None:
    """
    持续批量消费队列

    🔴 **停的时候要置位 `stop_event` 等它自己退出，不要直接 `cancel()`。** 消费者手里
    常年攥着一批「已经出队、还没写」的项目（攒满一批或等满超时才写），`cancel()`
    连同那一批一起丢掉。实测（改之前的代码）：入队 3 条后取消，写进去 0 条，队列也空了。

    :param queue: 用于获取项目的 `asyncio.Queue` 队列
    :param max_items: 从队列中获取的最大项目数量
    :param timeout: 总的等待超时时间（秒）
    :param handler: 批量处理函数
    :param queue_name: 队列名称，用于 Prometheus 标签
    :param error_message: 处理失败日志消息
    :param item_name: 队列数据名称
    :param stop_event: 停止信号。置位后把队列里剩下的处理完再退出
    :return:
    """
    while True:
        items = await batch_dequeue(
            queue, max_items=max_items, timeout=timeout, queue_name=queue_name, stop_event=stop_event
        )
        if not items:
            if stop_event is not None and stop_event.is_set():
                return
            continue

        try:
            await handler(items)
        except Exception as e:
            log.error(f'{error_message}，丢失 {len(items)} 条{item_name}: {e}')
        finally:
            for _ in items:
                queue.task_done()
                observe_queue_size(queue, queue_name=queue_name)
