import asyncio
import functools

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from celery import Task
from sqlalchemy.exc import SQLAlchemyError

from backend.common.log import log
from backend.common.socketio.actions import task_notification
from backend.core.conf import settings

_T = TypeVar('_T')


def with_timeout(seconds: float = settings.CELERY_TASK_TIME_LIMIT) -> Callable[..., Callable[..., Awaitable[_T]]]:
    """给任务函数补一个 `celery_aio_pool` 自己不做的超时保护

    🔴 **celery 标准的 `task_time_limit`/`task_soft_time_limit` 对这个 worker
    pool 完全无效**——`celery_aio_pool.AsyncIOPool.run()` 内部是
    `asyncio.run_coroutine_threadsafe(coro, self.loop)` 之后无限等待
    `.result()`，源码里没有任何 timer/信号相关的代码（prefork 池靠 `SIGALRM`
    实现，这个池什么都没接）。在 celery 配置里加那两个选项不会报错、也不会
    抛异常，只是**安静地不生效**——这正是本仓库最容易踩的那类坑的同一个形状。

    ⚠️ **不要试图靠重写 `TaskBase.__call__` 来做这件事。** `celery_aio_pool`
    的 tracer 用 `task_has_custom(task, '__call__')` 判断要不要走协程调度：
    一旦 `TaskBase` 自己定义了 `__call__`（哪怕是 `async def`），`fun` 就会
    绑成 `task` 这个实例本身而不是 `task.run`，而 `AsyncIOPool.run()` 对"不是
    协程函数的可调用对象"会扔进 `asyncio.to_thread` 同步调用——同步调用一个
    `async def` 只会拿到一个**从来没被 await 过的协程对象**，任务在日志里
    悄无声息地不执行任何一行。实测确认过这条路径，所以超时只能包在任务函数
    自己这层，不能碰 `Task` 的调度接口。

    用法：`@celery_app.task(...)` 之下、`async def` 任务函数之上，
    使 `task.run` 指向这层包装而不是裸函数——`fun = task.run`（`tracer.py`
    的取值逻辑）拿到的就是这个 `wrapper`。

    :param seconds: 超时秒数，默认 `settings.CELERY_TASK_TIME_LIMIT`
    """

    def decorator(fn: Callable[..., Awaitable[_T]]) -> Callable[..., Awaitable[_T]]:
        @functools.wraps(fn)
        async def wrapper(*args: Any, **kwargs: Any) -> _T:
            try:
                return await asyncio.wait_for(fn(*args, **kwargs), timeout=seconds)
            except TimeoutError:
                log.error(f'任务 {fn.__name__} 超过 {seconds}s 未完成，已强制中断')
                raise

        return wrapper

    return decorator


class TaskBase(Task):
    """Celery 任务基类。

    执行记录**不在这里写** —— 由 `database.py` 的 DatabaseBackend 落进 `task_result`
    表（celery 自己在任务生命周期里调它）。这里的钩子只负责实时提示。

    ⚠️ 提示是**推送**，不是记录：socket.io 那条 toast 转瞬即逝，刷新就没。
    真要查「上次几点跑的、失败在哪一行」永远看 `task_result` 表和执行记录页。
    上游的 taskiq 插件只推不存，那是它的问题，别学。

    ⚠️ 下面三条 `task_notification` 的文案不过 `tm()`，永远是中文，
    不受 `Accept-Language` 影响——这是范围内的决定，不是漏翻：
    socket.io 推送在业务代码里直接拼串发出去，没有走 HTTP 响应出口
    （`exception_handler.py` / `response_schema.py`），`i18n.current_language`
    在这条路径上无意义。要让它也支持英文，得在推送前显式调 `tm()`。
    """

    autoretry_for = (SQLAlchemyError,)
    max_retries = settings.CELERY_TASK_MAX_RETRIES
    # (issue #60) worker 进程被杀死（滚动发版 / OOM）时，正在执行的任务此前
    # 会直接丢失——消息在领取时就已经 ack 给 broker，不会被别的副本重新捡起。
    # prune_logs/prune_task_results 都是按 cutoff 幂等删除，重复执行安全。
    acks_late = True
    reject_on_worker_lost = True

    async def before_start(self, task_id: str, args, kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
        await task_notification(msg=f'任务 {self.name}（{task_id}）开始执行')

    async def on_success(self, retval: Any, task_id: str, args, kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
        await task_notification(msg=f'任务 {self.name}（{task_id}）执行成功')

    def on_failure(self, exc: Exception, task_id: str, args, kwargs, einfo) -> None:  # ruff:ignore[missing-type-function-argument]
        # 🔴 这个钩子是**同步**的（celery 只把 before_start/on_success 交给 aio pool），
        # 所以推送只能扔进事件循环。没有运行中的循环时不能让它把任务本身带崩 ——
        # 失败已经写进 task_result 了，少一条 toast 不该变成第二次失败。
        log.error(f'任务 {self.name}（{task_id}）执行失败：{exc}')
        try:
            asyncio.get_running_loop().create_task(
                task_notification(msg=f'任务 {self.name}（{task_id}）执行失败：{exc}')
            )
        except RuntimeError:
            pass
