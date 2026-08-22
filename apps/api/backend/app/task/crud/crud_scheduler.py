from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy_crud_plus import CRUDPlus

from backend.app.task.model import TaskExtended, TaskScheduler
from backend.app.task.schema.scheduler import CreateTaskSchedulerParam, UpdateTaskSchedulerParam
from backend.utils.timezone import timezone


class CRUDTaskScheduler(CRUDPlus[TaskScheduler]):
    """任务调度数据库操作类"""

    async def get(self, db: AsyncSession, pk: int) -> TaskScheduler | None:
        return await self.select_model(db, pk, deleted=0)

    async def get_by_name(self, db: AsyncSession, name: str) -> TaskScheduler | None:
        """按名称查。用来在 service 层拦重名 —— 库上 (name, deleted) 有唯一约束，
        不先查的话用户拿到的是一句数据库层面的 IntegrityError。"""
        return await self.select_model_by_column(db, name=name, deleted=0)

    async def get_select(self, name: str | None, task: str | None, enabled: bool | None) -> Select:
        filters: dict = {'deleted': 0}
        if name:
            filters['name__like'] = f'%{name}%'
        if task:
            filters['task__like'] = f'%{task}%'
        if enabled is not None:
            filters['enabled'] = enabled
        return await self.select_order('id', 'desc', **filters)

    async def get_all(self, db: AsyncSession) -> Sequence[TaskScheduler]:
        return await self.select_models(db, deleted=0)

    async def create(self, db: AsyncSession, obj: CreateTaskSchedulerParam) -> TaskScheduler:
        # flush=True：id 由数据库生成，不 flush 就返回会让响应序列化 500
        return await self.create_model(db, obj, flush=True)

    async def update(self, db: AsyncSession, pk: int, obj: UpdateTaskSchedulerParam) -> int:
        return await self.update_model_by_column(db, obj, id=pk, deleted=0)

    async def set_enabled(self, db: AsyncSession, pk: int, enabled: bool) -> int:
        return await self.update_model_by_column(db, {'enabled': enabled}, id=pk, deleted=0)

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        return await self.delete_model_by_column(
            db,
            allow_multiple=True,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id__in=pks,
            deleted=0,
        )


class CRUDTaskResult(CRUDPlus[TaskExtended]):
    """任务执行记录数据库操作类。

    ⚠️ 这张表由 **celery 自己**写（`database.py` 的 DatabaseBackend），
    这里只读和删 —— 没有 create/update，故意的。

    🔴 **必须绑 `TaskExtended` 而不是 `Task`。** 两者是**同一张表**
    （`extend_existing=True`），但 `name` / `worker` / `retries` / `queue` /
    `args` / `kwargs` 六列只声明在 `TaskExtended` 上 —— 查 `Task` 只 select
    得到基础列，那六列在响应里**全是 null**。

    症状很骗人：接口 200、条数对、时间和状态都对，只有「任务名」和
    「执行节点」两列显示 `—`，像是 celery 没写进去。实际是我们没查出来。
    是在浏览器里打开执行记录页才发现的 —— 接口测试当时只断言了
    `'items' in body`，太弱，抓不到（已补 `test_result_fields_are_extended`）。
    """

    async def get(self, db: AsyncSession, pk: int) -> TaskExtended | None:
        return await self.select_model(db, pk)

    async def get_select(
        self,
        name: str | None,
        task_id: str | None,
        status: str | None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        """执行记录列表的查询表达式。

        时间范围打在 `date_done` 上（那也是列表里显示的那一列，以及
        `maintenance.prune_task_results` 清理时用的那一列，三处一致）。

        ⚠️ 两端都是**闭区间**（`>=` / `<=`）。前端传的 `end_time` 一定是
        `… 23:59:59` 这种带时分秒的完整时刻 —— 只传日期的话 pydantic 会解析成
        当天 00:00:00，`<=` 就**静默丢掉最后一整天**。压缩发生在 URL 上，
        解码时立刻补回规范形式（`ui/components/query-bar` 那节）。
        """
        stmt = select(self.model)
        if name:
            stmt = stmt.where(self.model.name.like(f'%{name}%'))
        if task_id:
            stmt = stmt.where(self.model.task_id == task_id)
        if status:
            stmt = stmt.where(self.model.status == status)
        if start_time is not None:
            stmt = stmt.where(self.model.date_done >= start_time)
        if end_time is not None:
            stmt = stmt.where(self.model.date_done <= end_time)
        # 🔴 SQL Server 的 OFFSET FETCH 强制要求 ORDER BY，分页查询不能省
        return stmt.order_by(self.model.id.desc())

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        # 物理删 —— 这张表是 celery 的管道，没有 deleted 列
        return await self.delete_model_by_column(db, allow_multiple=True, id__in=pks)


task_scheduler_dao: CRUDTaskScheduler = CRUDTaskScheduler(TaskScheduler)
task_result_dao: CRUDTaskResult = CRUDTaskResult(TaskExtended)
