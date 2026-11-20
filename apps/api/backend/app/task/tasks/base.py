import asyncio
import functools
import time

from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from celery import Task
from sqlalchemy.exc import SQLAlchemyError

from backend.app.task.utils.notify import notify_task_watchers
from backend.common.data_change import data_change_source
from backend.common.log import log
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
            # 数据变更审计（#260）：任务里改的登记过的数据记成「定时任务」来源，
            # 引用是任务名（`maintenance.prune_logs`）。
            # 每个任务都套着这一层，所以接在这里 —— 不接的话 worker 里的修改没有请求上下文，记成「系统」，
            # 而筛选下拉里的「定时任务」永远是空的（评审抓到的）。上下文变量在 wait_for 建任务之前设，子任务会继承
            with data_change_source('task', f'{fn.__module__.rsplit(".", 2)[-2]}.{fn.__name__}'):
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

    ⚠️ 提示只推给能看执行记录的人（`app/task/utils/notify.py`，#400），不是全站广播。

    ⚠️ 下面三条提示的文案不过 `tm()`，永远是中文，
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

    #: 开始 / 成功时要不要推送。高频任务（`health.heartbeat`，每分钟一次）在装饰器上传
    #: `notify=False` 关掉 —— 每推一次都要查一遍谁能看执行记录、按人推。失败照推（同一任务 60 秒内一次）
    notify: bool = True

    async def before_start(self, task_id: str, args, kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
        if self.notify:
            await notify_task_watchers(f'任务 {self.name}（{task_id}）开始执行')

    async def on_success(self, retval: Any, task_id: str, args, kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
        if self.notify:
            await notify_task_watchers(f'任务 {self.name}（{task_id}）执行成功')

    def on_failure(self, exc: Exception, task_id: str, args, kwargs, einfo) -> None:  # ruff:ignore[missing-type-function-argument]
        """失败提示（#400）：投进 AsyncIOPool 自己的循环，只推给看得到执行记录的人，不带异常原文

        🔴 **这个钩子是同步的，而且不在事件循环里跑。** celery_aio_pool 的 tracer 只把 before_start / on_success
        交给池的循环，失败走 celery 自己的 `handle_failure`，在 worker 主线程里同步调这里。原来的写法是
        `asyncio.get_running_loop().create_task(...)` 外面包 `except RuntimeError: pass` —— 主线程上没有正在跑的循环，
        **每一次**都抛 `RuntimeError: no running event loop`、每一次都被吞掉：
        从第一个 Celery 提交起，失败提示一条都没推出去过，task 分册里那句「失败照推」也就一直是假的。
        现在 `run_coroutine_threadsafe` 投进池的循环（和雪花节点初始化同一个，见 `celery.py: pool_loop`），不等它跑完。

        🔴 **内容只到「失败了，去执行记录看」。** `autoretry_for=(SQLAlchemyError,)` 重试耗尽后 `str(exc)` 带完整 SQL、
        绑定参数和数据库主机；原文在执行记录里（`task_result`，要 `task:result:list` 才看得到），推送不再复制一份。

        同一个任务 `FAILURE_NOTIFY_INTERVAL_SECONDS` 秒内只推一次：每 15 秒一次的投递任务在库挂掉时会连续失败，
        不收的话管理员每 15 秒弹一条一样的提示。日志照记每一次。
        """
        log.error(f'任务 {self.name}（{task_id}）执行失败：{exc}')
        if not self._failure_notify_due():
            return
        coro = notify_task_watchers(f'任务 {self.name}（{task_id}）执行失败，详情见执行记录')
        from backend.app.task.celery import pool_loop

        loop = pool_loop()
        if loop is None:
            # 不是 AsyncIOPool（eager 模式 / 测试里直接调）：没有能投的循环，只留上面那条日志
            coro.close()
            return
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        future.add_done_callback(_log_notify_error)

    def _failure_notify_due(self) -> bool:
        now = time.monotonic()
        last = _last_failure_notified.get(self.name)
        if last is not None and now - last < FAILURE_NOTIFY_INTERVAL_SECONDS:
            return False
        _last_failure_notified[self.name] = now
        return True


#: 同一个任务两次失败提示之间至少隔多久（秒）
FAILURE_NOTIFY_INTERVAL_SECONDS = 60

# 任务名 → 上次推失败提示的时刻（monotonic）。每个 worker 进程一份，够用：要防的是同一个进程里高频任务连续失败刷屏
_last_failure_notified: dict[str, float] = {}


def _log_notify_error(future: 'asyncio.Future[None] | Any') -> None:
    if not future.cancelled() and (e := future.exception()) is not None:
        log.warning(f'任务失败提示推送失败：{e!r}')
