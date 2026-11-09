import math

from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_user_password_history import user_password_history_dao
from backend.app.admin.model import User
from backend.app.admin.schema.user_password_history import CreateUserPasswordHistoryParam
from backend.common.enums import LoginLogEvent
from backend.common.exception import errors
from backend.common.i18n import t
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.dynamic_config import load_user_security_config
from backend.utils.timezone import timezone


class UserPasswordHistoryService:
    """用户密码历史服务类"""

    @staticmethod
    async def peek_lock_reason(user_id: int, user_status: int) -> str | None:
        """
        查用户是否处于停用 / 锁定状态，返回文案而**不抛异常**

        🔴 **调用方必须等到密码校验通过之后才把它抛出去。**

        原来这里叫 `check_status`，直接抛，且在 `user_verify` 里排在密码校验
        **之前**。两个后果：
          1. 攻击者无需任何凭据即可区分「账号存在且被锁」和「账号不存在」——
             文案完全不同，用户枚举比状态码那条还好用；
          2. 更糟的是拿 5 次错误密码就能**锁死任意已知账号**（阈值 5 / 5 分钟），
             这是一个不需要任何权限的 DoS。

        改成返回值之后，调用方先验密码：密码不对一律回「用户名或密码有误」，
        密码对了才如实告知被锁 —— 此时告知已无枚举价值，而用户确实需要这句话
        才知道要去找管理员。

        自动解锁（到期清 Redis）保留在原位，那部分没有信息泄漏。

        :param user_id: 用户 ID
        :param user_status: 用户状态
        :return: 锁定原因文案，未锁定返回 None
        """
        if not user_status:
            return t('error.auth.account_locked')

        locked_until_str = await redis_client.get(f'{settings.USER_LOCK_REDIS_PREFIX}:{user_id}')

        if locked_until_str:
            locked_until = timezone.from_str(locked_until_str)
            now = timezone.now()
            if locked_until > now:
                remaining_minutes = math.ceil((locked_until - now).total_seconds() / 60)
                return t('error.auth.temporarily_locked', minutes=remaining_minutes)

            await redis_client.delete(f'{settings.USER_LOCK_REDIS_PREFIX}:{user_id}')
            await redis_client.delete(f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}')

        return None

    @staticmethod
    async def check_ip_lock(ip: str) -> None:
        """
        进门先看这个 IP 是不是已经超了跨账号失败阈值

        :param ip: 请求来源 IP
        :return:
        """
        if settings.LOGIN_IP_LOCK_THRESHOLD == 0:
            return
        count = await redis_client.get(f'{settings.LOGIN_IP_FAILURE_PREFIX}:{ip}')
        if count and int(count) >= settings.LOGIN_IP_LOCK_THRESHOLD:
            # 与「用户名或密码有误」完全同一个状态码和文案 ——
            # 不给攻击者「我被 IP 封了」这个反馈，否则他知道该换出口了
            raise errors.AuthorizationError(msg=t('error.auth.invalid_credentials'))

    @staticmethod
    async def handle_ip_login_failure(ip: str, username: str | None = None) -> None:
        """
        按 IP 累计登录失败，防跨账号密码喷洒

        :param ip: 请求来源 IP
        :param username: 这次试的用户名（达到阈值那一次记进登录日志，#273）
        :return:
        """
        if settings.LOGIN_IP_LOCK_THRESHOLD == 0:
            return
        key = f'{settings.LOGIN_IP_FAILURE_PREFIX}:{ip}'
        count = await redis_client.incr(key)
        if count == 1:
            await redis_client.expire(key, settings.LOGIN_IP_LOCK_SECONDS)
        if count == settings.LOGIN_IP_LOCK_THRESHOLD:
            # 🔴 对方看到的仍是「用户名或密码有误」（check_ip_lock 不给攻击者反馈），所以**只有这一行**
            # 让管理员知道这个 IP 被锁了。`==` 不是 `>=`：只在跨过阈值的那一次记，锁住之后的每次尝试不再记
            await _record_lock(
                LoginLogEvent.ip_locked,
                key='login_event.ip_locked',
                seconds=settings.LOGIN_IP_LOCK_SECONDS,
                count=count,
                username=username,
            )

    @staticmethod
    async def handle_ip_login_success(ip: str) -> None:
        """登录成功清掉该 IP 的失败计数"""
        await redis_client.delete(f'{settings.LOGIN_IP_FAILURE_PREFIX}:{ip}')

    @staticmethod
    async def handle_login_failure(db: AsyncSession, user_id: int) -> None:
        """
        处理登录失败

        :param db: 数据库会话
        :param user_id: 用户 ID
        :return:
        """
        await load_user_security_config(db)

        if settings.USER_LOCK_THRESHOLD == 0:
            return

        failure_count = await redis_client.get(f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}')
        failure_count = int(failure_count) if failure_count else 0
        failure_count += 1
        await redis_client.set(
            f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}',
            str(failure_count),
            ex=settings.USER_LOCK_SECONDS,
        )

        if failure_count >= settings.USER_LOCK_THRESHOLD:
            lock_key = f'{settings.USER_LOCK_REDIS_PREFIX}:{user_id}'
            newly_locked = not await redis_client.exists(lock_key)
            locked_until = timezone.now() + timedelta(seconds=settings.USER_LOCK_SECONDS)
            await redis_client.set(lock_key, timezone.to_str(locked_until), ex=settings.USER_LOCK_SECONDS)
            if newly_locked:
                # #273：锁定那一刻记一行。原来只有那一次失败尝试的文案碰巧写着「账号已被锁定」，没法筛；
                # 解锁是到期自动的（这里没有手动解锁），锁到几点写在这一行里
                # 用调用方自己的会话读：`record_event` 另开会话、不读 `sys_user`（理由见那里）
                user = (await db.execute(select(User.uuid, User.username).where(User.id == user_id))).first()
                await _record_lock(
                    LoginLogEvent.locked,
                    key='login_event.locked',
                    seconds=settings.USER_LOCK_SECONDS,
                    count=failure_count,
                    user_uuid=user.uuid if user else None,
                    username=user.username if user else None,
                )
            raise errors.AuthorizationError(msg=t('error.auth.too_many_failed_attempts'))

    @staticmethod
    async def check_password_expiry_status(db: AsyncSession, password_changed_time: datetime) -> int | None:
        """
        检查密码过期状态

        :param db: 数据库会话
        :param password_changed_time: 密码修改时间
        :return:
        """
        await load_user_security_config(db)

        if settings.USER_PASSWORD_EXPIRY_DAYS == 0:
            return None

        if not password_changed_time:
            raise errors.AuthorizationError(msg=t('error.auth.password_expired'))

        expiry_time = password_changed_time + timedelta(days=settings.USER_PASSWORD_EXPIRY_DAYS)
        days_remaining = (expiry_time - timezone.now()).days

        if days_remaining < 0:
            raise errors.AuthorizationError(msg=t('error.auth.password_expired'))

        if days_remaining <= settings.USER_PASSWORD_REMINDER_DAYS:
            return days_remaining

        return None

    @staticmethod
    async def handle_login_success(user_id: int) -> None:
        """
        处理登录成功

        :param user_id: 用户 ID
        :return:
        """
        await redis_client.delete(f'{settings.USER_LOCK_REDIS_PREFIX}:{user_id}')
        await redis_client.delete(f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}')

    @staticmethod
    async def save_password_history(db: AsyncSession, obj: CreateUserPasswordHistoryParam) -> None:
        """
        保存密码历史记录

        :param db: 数据库会话
        :param obj: 创建密码历史记录参数
        :return:
        """
        await user_password_history_dao.create(db, obj)


async def _record_lock(
    event: str, *, key: str, seconds: int, count: int, user_uuid: str | None = None, username: str | None = None
) -> None:
    """锁定（账号 / IP）那一刻记进登录日志。IP / 设备取这次请求的 —— 正是在试密码的那一方"""
    from backend.app.admin.service.login_log_service import login_log_service

    until = timezone.now() + timedelta(seconds=seconds)
    await login_log_service.record_event(
        event=event,
        msg=t(key, count=count, minutes=math.ceil(seconds / 60), until=until.strftime('%H:%M')),
        user_uuid=user_uuid,
        username=username,
    )


password_security_service: UserPasswordHistoryService = UserPasswordHistoryService()
