from collections.abc import Mapping
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_login_log import login_log_dao
from backend.app.admin.schema.login_log import CreateLoginLogParam, DeleteLoginLogParam
from backend.common.context import ctx
from backend.common.enums import LoginLogEvent, LoginLogStatusType
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.common.security.session import EndReason, on_session_revoked
from backend.database.db import async_db_session, uuid4_str
from backend.utils.timezone import timezone

#: 请求上下文里和「这次请求从哪来」有关的那几样（登录日志的 ip / 地点 / 设备列）
_REQUEST_FIELDS = ('ip', 'country', 'region', 'city', 'user_agent', 'browser', 'os', 'device')


class LoginLogService:
    """登录日志服务类"""

    @staticmethod
    async def get_list(
        *,
        db: AsyncSession,
        username: str | None,
        status: int | None,
        ip: str | None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
        event: str | None = None,
    ) -> dict[str, Any]:
        """
        获取登录日志列表

        :param db: 数据库会话
        :param username: 用户名
        :param status: 状态
        :param ip: IP 地址
        :param start_time: 登录时间起
        :param end_time: 登录时间止
        :param event: 事件（`LoginLogEvent`）
        :return:
        """
        log_select = await login_log_dao.get_select(
            username=username, status=status, ip=ip, start_time=start_time, end_time=end_time, event=event
        )
        return await paging_data(db, log_select)

    @staticmethod
    async def create(
        *,
        user_uuid: str,
        username: str,
        login_time: datetime,
        status: int,
        msg: str,
    ) -> None:
        """
        创建登录日志

        :param user_uuid: 用户 UUID
        :param username: 用户名
        :param login_time: 登录时间
        :param status: 状态
        :param msg: 消息
        :return:
        """
        try:
            obj = CreateLoginLogParam(
                user_uuid=user_uuid,
                username=username,
                status=status,
                ip=ctx.ip,
                country=ctx.country,
                region=ctx.region,
                city=ctx.city,
                user_agent=ctx.user_agent,
                browser=ctx.browser,
                os=ctx.os,
                device=ctx.device,
                msg=msg,
                login_time=login_time,
            )
            # 为后台任务创建独立数据库会话
            async with async_db_session.begin() as db:
                await login_log_dao.create(db, obj)
        except Exception as e:
            log.error(f'登录日志创建失败: {e}')

    @staticmethod
    async def record_event(
        *,
        event: str,
        msg: str,
        user_uuid: str | None = None,
        username: str | None = None,
        device: Mapping[str, Any] | None = None,
    ) -> None:
        """记一条安全事件（#273：账号被锁 / IP 被锁 / 被强制下线），不是一次登录尝试。

        和 `create` 一样开自己的会话、吞掉异常：记不下来不能让触发它的那件事（拒绝登录、踢人）跟着失败。

        🔴 **这里不读 `sys_user`，是谁由调用方给。** 改密码 / 停用 / 删除都是先 UPDATE 用户那一行、
        再撤销会话（→ 这里），而调用方的事务要等这里返回才提交。这里另开的会话去读那一行，在 SQL Server 上
        （读要加共享锁）就排在调用方的排他锁后面，调用方又在等这里 —— 应用层的死锁，数据库看不见，请求永远挂着。
        PostgreSQL 读不被写挡，测不出来。见 `app/admin/AGENTS.md`「登录日志里的安全事件」

        :param event: `LoginLogEvent`
        :param msg: 说明（已经按当前语言翻好）
        :param user_uuid: 是谁的事；不知道（IP 被锁时试的那个用户名可能根本不存在）就随机一个，同登录失败
        :param username: 用户名
        :param device: 🔴 被踢下线那条要记**被踢的那个会话**的 IP / 浏览器，不是点按钮的管理员的。不给就取这次请求的
        """
        try:
            if device is None:
                device = {k: getattr(ctx, k) for k in _REQUEST_FIELDS} if ctx.exists() else {}
            async with async_db_session.begin() as db:
                obj = CreateLoginLogParam(
                    user_uuid=user_uuid or uuid4_str(),
                    username=username or '-',
                    status=LoginLogStatusType.fail.value,
                    ip=device.get('ip') or '-',
                    country=device.get('country') or None,
                    region=device.get('region') or None,
                    city=device.get('city') or None,
                    user_agent=device.get('user_agent') or None,
                    browser=device.get('browser') or None,
                    os=device.get('os') or None,
                    device=device.get('device') or None,
                    msg=msg,
                    login_time=timezone.now(),
                    event=event,
                )
                await login_log_dao.create(db, obj)
        except Exception as e:
            log.error(f'登录日志安全事件记录失败（{event}）: {e}')

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteLoginLogParam) -> int:
        """
        批量删除登录日志

        :param db: 数据库会话
        :param obj: 日志 ID 列表
        :return:
        """
        count = await login_log_dao.delete(db, obj.pks)
        return count

    @staticmethod
    async def delete_all(*, db: AsyncSession) -> None:
        """清空所有登录日志"""
        await login_log_dao.delete_all(db)


login_log_service: LoginLogService = LoginLogService()


#: 哪些下线算「被强制下线」→ 说明文案。自己登出、被同一浏览器的新登录挤掉、空闲 / 到期都不算
_FORCED_LOGOUT = {
    EndReason.kicked: 'login_event.kicked',
    EndReason.password_changed: 'login_event.password_changed',
    EndReason.disabled: 'login_event.disabled',
}


def _operator_label(operator_id: int | None, user_id: int | None) -> str:
    if operator_id is None:
        return t('login_event.system')
    if operator_id == user_id:
        return t('login_event.self')
    # 不查库（理由见 `record_event`）：JWT 认证时已经把当前用户名放进了请求上下文
    return ctx.username or str(operator_id)


@on_session_revoked
async def record_forced_logout(_session_uuid: str, reason: str, fields: Mapping[str, str]) -> None:
    """会话被强制结束（#273）：管理员踢下线 / 改密码 / 停用账号。挂在会话层唯一的撤销入口上，见 `on_session_revoked`"""
    key = _FORCED_LOGOUT.get(reason)
    if key is None:
        return
    user_id = int(fields['uid']) if fields.get('uid') else None
    operator_id = ctx.user_id if ctx.exists() else None
    await login_log_service.record_event(
        event=LoginLogEvent.kicked,
        msg=t(key, operator=_operator_label(operator_id, user_id)),
        # 登录时存进会话的快照（`auth_service.session_meta`）。升级前登录的会话里没有 uuid，那几天记一个随机的
        user_uuid=fields.get('uuid'),
        username=fields.get('username'),
        # 会话里存的是登录那一刻的 IP / 设备（`auth_service.session_meta`），没有地点
        device={k: fields.get(k) for k in ('ip', 'browser', 'os', 'device')},
    )
