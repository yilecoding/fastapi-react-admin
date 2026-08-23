from datetime import datetime

from sqlalchemy import Select
from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import OperaLog
from backend.app.admin.schema.opera_log import CreateOperaLogParam
from backend.common.security.data_scope import DataScopedCRUD


class CRUDOperaLogDao(DataScopedCRUD[OperaLog]):
    """操作日志数据库操作类"""

    async def get_select(
        self,
        username: str | None,
        status: int | None,
        ip: str | None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        """
        获取操作日志列表查询表达式

        :param username: 用户名
        :param status: 操作状态
        :param ip: IP 地址
        :param start_time: 操作时间起（含）
        :param end_time: 操作时间止（含）
        :return:
        """
        filters = {}

        if username is not None:
            filters['username__like'] = f'%{username}%'
        if status is not None:
            filters['status__eq'] = status
        if ip is not None:
            filters['ip__like'] = f'%{ip}%'
        # 日志排查基本都是按时间段捞，没有时间范围筛选很难用
        if start_time is not None:
            filters['opera_time__ge'] = start_time
        if end_time is not None:
            filters['opera_time__le'] = end_time

        return await self.select_order('created_time', 'desc', **filters)

    async def create(self, db: AsyncSession, obj: CreateOperaLogParam) -> None:
        """
        创建操作日志

        :param db: 数据库会话
        :param obj: 操作日志创建参数
        :return:
        """
        await self.create_model(db, obj)

    async def bulk_create(self, db: AsyncSession, objs: list[CreateOperaLogParam]) -> None:
        """
        批量创建操作日志

        :param db: 数据库会话
        :param objs: 操作日志创建参数列表
        :return:
        """
        await self.create_models(db, objs)

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """
        批量删除操作日志

        :param db: 数据库会话
        :param pks: 操作日志 ID 列表
        :return:
        """
        return await self.delete_model_by_column(db, allow_multiple=True, id__in=pks)

    @staticmethod
    async def delete_all(db: AsyncSession) -> None:
        """
        删除所有日志

        :param db: 数据库会话
        :return:
        """
        await db.execute(sa_delete(OperaLog))


opera_log_dao: CRUDOperaLogDao = CRUDOperaLogDao(OperaLog)
