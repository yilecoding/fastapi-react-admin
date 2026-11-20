from datetime import datetime

from sqlalchemy import Select, select
from sqlalchemy import delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import LoginLog
from backend.app.admin.schema.login_log import CreateLoginLogParam
from backend.common.security.data_scope import DataScopedCRUD


class CRUDLoginLog(DataScopedCRUD[LoginLog]):
    """登录日志数据库操作类"""

    async def get_select(
        self,
        username: str | None,
        status: int | None,
        ip: str | None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        event: str | None = None,
    ) -> Select:
        """
        获取登录日志列表查询表达式

        :param username: 用户名
        :param status: 登录状态
        :param ip: IP 地址
        :param start_time: 登录时间起（含）
        :param end_time: 登录时间止（含）
        :param event: 事件（`LoginLogEvent`）
        :return:
        """
        filters = {}
        if event is not None:
            filters['event'] = event

        if username is not None:
            filters['username__like'] = f'%{username}%'
        if status is not None:
            filters['status'] = status
        if ip is not None:
            filters['ip__like'] = f'%{ip}%'
        # 安全审计基本都是「看某段时间内的失败登录」，没有时间范围很难用
        if start_time is not None:
            filters['login_time__ge'] = start_time
        if end_time is not None:
            filters['login_time__le'] = end_time

        return await self.select_order('created_time', 'desc', **filters)

    @staticmethod
    async def get_recent_by_username(db: AsyncSession, username: str, limit: int) -> list[LoginLog]:
        """
        某个登录名最近的登录记录（个人中心「最近登录」）

        🔴 按 `username` **全等**，两种别的写法都会错：
        - 复用列表那条 `username LIKE`：登录名 `admin` 会把 `admin2` 的记录一起捞回来
        - 按 `user_uuid`：密码错的那次失败尝试记的是**随机 uuid**（`user_verify` 抛异常时还没拿到用户，
          见 `auth_service.login`），而「有人在试你的密码」恰恰是这块最要紧的那几行

        按 `login_time`（有索引）倒序取前几条，不按没索引的 `created_time` —— 日志表是全库长得最快的表

        :param db: 数据库会话
        :param username: 登录名
        :param limit: 条数
        :return:
        """
        stmt = (
            select(LoginLog)
            .where(LoginLog.username == username)
            .order_by(LoginLog.login_time.desc(), LoginLog.id.desc())
            .limit(limit)
        )
        return list((await db.scalars(stmt)).all())

    async def create(self, db: AsyncSession, obj: CreateLoginLogParam) -> None:
        """
        创建登录日志

        :param db: 数据库会话
        :param obj: 创建登录日志参数
        :return:
        """
        await self.create_model(db, obj, commit=True)

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """
        批量删除登录日志

        :param db: 数据库会话
        :param pks: 登录日志 ID 列表
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
        await db.execute(sa_delete(LoginLog))


login_log_dao: CRUDLoginLog = CRUDLoginLog(LoginLog)
