import json

from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.task.crud import task_result_dao, task_scheduler_dao
from backend.app.task.model import TaskScheduler
from backend.app.task.schema.scheduler import (
    CreateTaskSchedulerParam,
    DeleteTaskResultParam,
    DeleteTaskSchedulerParam,
    UpdateTaskSchedulerParam,
)
from backend.common.exception import errors
from backend.common.i18n import t


class TaskSchedulerService:
    """任务调度服务"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> TaskScheduler:
        obj = await task_scheduler_dao.get(db, pk)
        if not obj:
            raise errors.NotFoundError(msg=t('error.task.scheduler_not_found'))
        return obj

    @staticmethod
    async def get_select(*, name: str | None, task: str | None, enabled: bool | None) -> Select:
        return await task_scheduler_dao.get_select(name, task, enabled)

    @staticmethod
    async def get_all(*, db: AsyncSession) -> Sequence[TaskScheduler]:
        return await task_scheduler_dao.get_all(db)

    @staticmethod
    def get_registered_tasks() -> list[str]:
        """列出注册了哪些 Celery 任务。

        🔴 **这个必须有。** 调度表里的 `task` 是个自由字符串，打错一个字
        （`maintenance.prune_log` 少个 s）就是「调度按时触发了，但 worker
        收到一个不认识的名字」—— celery 侧记一条 `Received unregistered task`，
        而界面上那条调度的「累计触发次数」照涨，看起来一切正常。
        所以表单里的任务名要从这个列表里选，不给人手敲。

        🔴 **`import_default_modules()` 不能省。** `autodiscover_tasks()` 是
        **惰性**的：它只登记一个回调，等 app finalize（通常是 worker 启动）
        时才真去 import 那些模块。web 进程从不 finalize，所以直接读
        `celery_app.tasks` 拿到的是**空列表** —— 表现是「创建调度时说
        『任务 maintenance.prune_logs 未注册；可用的有：（无）』」，
        而那个任务明明在 worker 里跑得好好的。接口测试第一次跑就抓到了这条。
        """
        from backend.app.task.celery import celery_app

        celery_app.loader.import_default_modules()
        return sorted(
            name
            for name in celery_app.tasks
            if not name.startswith('celery.')  # celery 内建的那几个（backend_cleanup 等）不给选
        )

    @staticmethod
    def get_meta() -> dict[str, object]:
        """调度运行时的元信息：能选哪些任务、beat 按哪个时区解释 crontab。

        🔴 **时区必须由后端下发。** 前端算「近五次执行时间」预览时，要按
        **beat 解释 crontab 的那个时区**去算，而不是浏览器时区 ——
        两者不同时（运维在国外、或用户改了显示时区），预览出来的时间
        看着像模像样，实际和真正触发的时刻差好几个小时。

        beat 用的是**进程级**的 `settings.DATETIME_TIMEZONE`，
        和 `sys_user.timezone`（那是每个人的**显示**偏好）是两回事。
        """
        from backend.core.conf import settings

        return {
            'tasks': TaskSchedulerService.get_registered_tasks(),
            'timezone': settings.DATETIME_TIMEZONE,
        }

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateTaskSchedulerParam) -> TaskScheduler:
        if await task_scheduler_dao.get_by_name(db, obj.name):
            raise errors.ConflictError(msg=t('error.task.scheduler_name_exists'))
        TaskSchedulerService._assert_task_registered(obj.task)
        return await task_scheduler_dao.create(db, obj)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateTaskSchedulerParam) -> int:
        current = await task_scheduler_dao.get(db, pk)
        if not current:
            raise errors.NotFoundError(msg=t('error.task.scheduler_not_found'))
        if obj.name != current.name and await task_scheduler_dao.get_by_name(db, obj.name):
            raise errors.ConflictError(msg=t('error.task.scheduler_name_exists'))
        TaskSchedulerService._assert_task_registered(obj.task)
        return await task_scheduler_dao.update(db, pk, obj)

    @staticmethod
    async def set_enabled(*, db: AsyncSession, pk: int, enabled: bool) -> int:
        if not await task_scheduler_dao.get(db, pk):
            raise errors.NotFoundError(msg=t('error.task.scheduler_not_found'))
        return await task_scheduler_dao.set_enabled(db, pk, enabled)

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteTaskSchedulerParam) -> int:
        return await task_scheduler_dao.delete(db, obj.pks)

    @staticmethod
    async def run_now(*, db: AsyncSession, pk: int) -> str:
        """立即执行一次。返回 celery 的 task_id，前端拿它去执行记录里查。"""
        from backend.app.task.celery import celery_app

        obj = await task_scheduler_dao.get(db, pk)
        if not obj:
            raise errors.NotFoundError(msg=t('error.task.scheduler_not_found'))

        args = json.loads(obj.args) if obj.args else []
        kwargs = json.loads(obj.kwargs) if obj.kwargs else {}
        result = celery_app.send_task(obj.task, args=args, kwargs=kwargs, queue=obj.queue or None)
        return result.id

    @staticmethod
    def _assert_task_registered(task: str) -> None:
        """拦住打错的任务名。

        ⚠️ 只在 **API 进程能看到任务注册表**时才有意义 —— celery_app 是同一份
        代码里的实例，`autodiscover_tasks` 在 import 时就跑了，所以 web 进程
        也认得全部任务名。真要跑起来还得 worker 活着，那是另一回事。
        """
        registered = TaskSchedulerService.get_registered_tasks()
        if task not in registered:
            raise errors.NotFoundError(
                msg=t('error.task.not_registered', task=task, available=', '.join(registered) or '-')
            )


class TaskResultService:
    """任务执行记录服务（只读 + 删）"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Any:
        obj = await task_result_dao.get(db, pk)
        if not obj:
            raise errors.NotFoundError(msg=t('error.task.result_not_found'))
        return obj

    @staticmethod
    async def get_select(
        *,
        name: str | None,
        task_id: str | None,
        status: str | None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        return await task_result_dao.get_select(name, task_id, status, start_time, end_time)

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteTaskResultParam) -> int:
        return await task_result_dao.delete(db, obj.pks)


task_scheduler_service: TaskSchedulerService = TaskSchedulerService()
task_result_service: TaskResultService = TaskResultService()
