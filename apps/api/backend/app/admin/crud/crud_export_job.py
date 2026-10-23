from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import ExportJob
from backend.common.enums import ExportJobStatus
from backend.common.security.data_scope import DataScopedCRUD
from backend.utils.timezone import timezone

_ACTIVE = (ExportJobStatus.pending.value, ExportJobStatus.running.value)


class CRUDExportJob(DataScopedCRUD[ExportJob]):
    """导出任务数据库操作类"""

    # 导出记录是**个人**的：每个读接口都按 `created_by == 当前用户` 强制过滤（同站内消息的收件箱），
    # 不归数据范围管 —— 那几个接口只挂登录，挂 scoped 的 DAO 会让受限用户连自己的导出都看不到
    # （security 分册「没有权限门禁的端点，绝不能挂 scoped 的 DAO」）
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> ExportJob | None:
        return await self.select_model(db, pk)

    async def get_mine(self, db: AsyncSession, pk: int, user_id: int) -> ExportJob | None:
        return await self.select_model_by_column(db, id=pk, created_by=user_id)

    async def get_select_mine(self, user_id: int, status: int | None) -> Select:
        filters: dict = {'created_by': user_id}
        if status is not None:
            filters['status'] = status
        return await self.select_order('created_time', 'desc', **filters)

    async def count_active(self, db: AsyncSession, user_id: int) -> int:
        stmt = select(func.count()).where(self.model.created_by == user_id, self.model.status.in_(_ACTIVE))
        return int((await db.execute(stmt)).scalar_one())

    async def count_live_on_storage(self, db: AsyncSession, storage_id: int) -> int:
        """某个存储上还没过期的导出文件数（删存储之前要查：导出文件不进 `sys_file`，文件那道检查看不见它们）。

        只数「已完成」：`storage_id` 是生成完那一刻和状态一起写的，生成中的还没有；而新导出只往**默认**存储写，
        默认存储本来就删不掉
        """
        stmt = select(func.count()).where(
            self.model.storage_id == storage_id, self.model.status == ExportJobStatus.succeeded
        )
        return int((await db.execute(stmt)).scalar_one())

    async def claim(self, db: AsyncSession, pk: int, *, stale_before: datetime) -> bool:
        """把任务抢成「生成中」。抢到才执行。

        🔴 一条条件 UPDATE 而不是「先查状态再改」：Celery 的 `acks_late` + `reject_on_worker_lost`
        会让同一个任务**投递不止一次**（worker 被杀、重新投递），两个 worker 都查到「排队」就会各生成一份。
        「生成中」但开始时间早于 `stale_before` 的也能抢 —— 那是上一个 worker 死在半路留下的
        """
        now = timezone.now()
        stmt = (
            update(self.model)
            .where(
                self.model.id == pk,
                or_(
                    self.model.status == ExportJobStatus.pending.value,
                    (self.model.status == ExportJobStatus.running.value) & (self.model.started_time < stale_before),
                ),
            )
            .values(status=ExportJobStatus.running.value, started_time=now, error=None, row_count=0)
        )
        result = await db.execute(stmt)
        return result.rowcount == 1

    async def get_stale(
        self, db: AsyncSession, *, stale_before: datetime, user_id: int | None = None
    ) -> Sequence[ExportJob]:
        """卡住的任务：排队 / 生成中，而且早就该结束了（worker 死了、消息丢了）"""
        stmt = select(self.model).where(
            or_(
                (self.model.status == ExportJobStatus.pending.value) & (self.model.created_time < stale_before),
                (self.model.status == ExportJobStatus.running.value) & (self.model.started_time < stale_before),
            )
        )
        if user_id is not None:
            stmt = stmt.where(self.model.created_by == user_id)
        return (await db.execute(stmt)).scalars().all()

    async def get_expired_batch(
        self, db: AsyncSession, *, now: datetime, after_id: int, limit: int
    ) -> Sequence[ExportJob]:
        """到期该删文件的成功记录，按 id 往后翻（keyset）。

        ⚠️ 不能每批从头取：删对象失败的那一行状态改不成「已过期」时，从头取会把它一直拿回来 ——
        死循环（task 分册「处理完这一行它就不再匹配」不成立的任务要 keyset）
        """
        stmt = (
            select(self.model)
            .where(
                self.model.status == ExportJobStatus.succeeded.value,
                self.model.expire_time < now,
                self.model.id > after_id,
            )
            .order_by(self.model.id)
            .limit(limit)
        )
        return (await db.execute(stmt)).scalars().all()

    async def get_old_ids(self, db: AsyncSession, *, before: datetime, limit: int) -> list[int]:
        """过了记录保留期的、已经结束的记录（成功的文件早在过期时删了）"""
        stmt = (
            select(self.model.id)
            .where(self.model.created_time < before, self.model.status.not_in(_ACTIVE))
            .order_by(self.model.id)
            .limit(limit)
        )
        return list((await db.execute(stmt)).scalars().all())

    async def delete_by_ids(self, db: AsyncSession, pks: list[int]) -> int:
        return await self.delete_model_by_column(db, allow_multiple=True, id__in=pks)


export_job_dao: CRUDExportJob = CRUDExportJob(ExportJob)
