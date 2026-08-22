import asyncio

from typing import Any

from celery import Task
from sqlalchemy.exc import SQLAlchemyError

from backend.common.log import log
from backend.common.socketio.actions import task_notification
from backend.core.conf import settings


class TaskBase(Task):
    """Celery 任务基类。

    执行记录**不在这里写** —— 由 `database.py` 的 DatabaseBackend 落进 `task_result`
    表（celery 自己在任务生命周期里调它）。这里的钩子只负责实时提示。

    ⚠️ 提示是**推送**，不是记录：socket.io 那条 toast 转瞬即逝，刷新就没。
    真要查「上次几点跑的、失败在哪一行」永远看 `task_result` 表和执行记录页。
    上游的 taskiq 插件只推不存，那是它的问题，别学。
    """

    autoretry_for = (SQLAlchemyError,)
    max_retries = settings.CELERY_TASK_MAX_RETRIES

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
