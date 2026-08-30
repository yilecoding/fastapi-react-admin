"""`with_timeout` 装饰器（issue #60）。

`celery_aio_pool.AsyncIOPool` 不实现 celery 标准的 `task_time_limit`/
`task_soft_time_limit`（源码里没有 timer/信号相关代码，`asyncio.run_coroutine_
threadsafe(...).result()` 无限等待），所以超时保护只能自己在任务函数这层补——
见 `tasks/base.py: with_timeout` 的完整说明。这里钉住装饰器本身的行为：
跑得快的正常返回，跑得慢的被掐断且抛出 `TimeoutError`。

⚠️ 本仓库没有配 pytest-asyncio/anyio 的 pytest 插件，`async def test_...`
不会被原生执行（会直接报"not natively supported"）。跟 `test_prune_logs.py`
一样，同步测试函数里显式 `asyncio.run()`。
"""

import asyncio

from backend.app.task.tasks.base import with_timeout


def test_completes_normally_within_timeout() -> None:
    @with_timeout(seconds=1)
    async def fast() -> str:
        await asyncio.sleep(0)
        return 'ok'

    assert asyncio.run(fast()) == 'ok'


def test_raises_timeout_error_when_exceeded() -> None:
    @with_timeout(seconds=0.05)
    async def slow() -> None:
        await asyncio.sleep(5)

    try:
        asyncio.run(slow())
    except TimeoutError:
        pass
    else:
        raise AssertionError('超时的任务应该抛出 TimeoutError')


def test_cancels_the_underlying_coroutine_on_timeout() -> None:
    """不只是外层抛异常——里面那个协程必须真的被取消，不能在后台继续跑"""
    ran_past_sleep = False

    async def go() -> None:
        nonlocal ran_past_sleep

        @with_timeout(seconds=0.05)
        async def slow() -> None:
            nonlocal ran_past_sleep
            await asyncio.sleep(5)
            ran_past_sleep = True  # 不应该跑到这里

        try:
            await slow()
        except TimeoutError:
            pass
        else:
            raise AssertionError('超时的任务应该抛出 TimeoutError')

        # 给事件循环一点时间，确认协程真的没有在背后继续跑完
        await asyncio.sleep(0.1)

    asyncio.run(go())
    assert ran_past_sleep is False
