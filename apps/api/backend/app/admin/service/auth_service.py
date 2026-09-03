from fastapi import Request, Response
from fastapi.security import HTTPBasicCredentials
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTask, BackgroundTasks
from starlette.concurrency import run_in_threadpool

from backend.app.admin.crud.crud_menu import menu_dao
from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import User
from backend.app.admin.schema.token import GetLoginToken, GetNewToken
from backend.app.admin.schema.user import AuthLoginParam
from backend.app.admin.service.login_log_service import login_log_service
from backend.app.admin.service.user_password_history_service import password_security_service
from backend.app.admin.utils.password_security import get_hash_password, password_verify
from backend.common.context import ctx
from backend.common.enums import LoginLogStatusType, StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.response.response_code import CustomErrorCode
from backend.common.security.jwt import (
    create_access_token,
    create_new_token,
    create_refresh_token,
    get_token,
    jwt_decode,
    revoke_token,
    set_refresh_cookie,
)
from backend.core.conf import settings
from backend.database.db import uuid4_str
from backend.database.redis import redis_client
from backend.utils.dynamic_config import load_login_config
from backend.utils.timezone import timezone

# 用户不存在时拿它跑一次等价的 bcrypt 校验，把时间侧信道抹平。
#
# 实测（bcrypt cost=12）：密码错要走完整 verify ≈ **190ms**，用户不存在只有一次
# SELECT ≈ **5ms**。40 倍差距，不需要任何统计手段就能区分 —— 状态码和文案统一之后，
# 时间差就成了剩下的那条枚举通道，所以这一步是必须的，不是加固。
#
# 🔴 导入期算一次。放进请求路径就是每次多付 190ms，而且那正是它要抹掉的那个数。
_DUMMY_PASSWORD_HASH = get_hash_password('fba::dummy::never-matches', None)


class AuthService:
    """认证服务类"""

    @staticmethod
    async def user_verify(db: AsyncSession, username: str, password: str) -> tuple[User, int | None]:
        """
        验证用户名和密码

        :param db: 数据库会话
        :param username: 用户名
        :param password: 密码
        :return:
        """
        ip = ctx.ip

        # 跨账号密码喷洒的第一道闸，进门就看
        await password_security_service.check_ip_lock(ip)

        user = await user_dao.get_by_username(db, username)
        if not user:
            # 🔴 必须跑一次等价的 bcrypt，否则「用户不存在」5ms、「密码错」190ms，
            # 状态码和文案统一了也白搭 —— 时间就是答案
            await run_in_threadpool(password_verify, password, _DUMMY_PASSWORD_HASH)
            await password_security_service.handle_ip_login_failure(ip)
            # 🔴 和密码错误返回**同一个** AuthorizationError（403）。
            # 原来这里是 NotFoundError（404），文案虽然早就统一成「用户名或密码有误」，
            # 但状态码的差异让用户名枚举照样成立
            raise errors.AuthorizationError(msg=t('error.auth.invalid_credentials'))

        # 🔴 只取原因、先不抛 —— 抛在密码校验之前会让攻击者无需凭据即可
        # 区分「账号存在且被锁」和「账号不存在」，并且能用错误密码锁死任意账号
        lock_reason = await password_security_service.peek_lock_reason(user.id, user.status)

        # OAuth2 创建的用户 password 为 NULL。原来 `user.password is None` 会短路掉
        # bcrypt，于是这类账号同样能被时间侧信道认出来 —— 让它也走一次哑校验
        hashed = user.password if user.password is not None else _DUMMY_PASSWORD_HASH
        # ⚠️ 190ms 的同步 bcrypt 会阻塞事件循环，必须进线程池
        verified = await run_in_threadpool(password_verify, password, hashed)
        if user.password is None or not verified:
            # 锁定期内不再累加，避免攻击者靠持续尝试无限延长他人的锁定时间
            if lock_reason is None:
                await password_security_service.handle_login_failure(db, user.id)
            await password_security_service.handle_ip_login_failure(ip)
            raise errors.AuthorizationError(msg=t('error.auth.invalid_credentials'))

        # 密码正确 —— 到这里才可以如实告知状态。此时告知已无枚举价值，
        # 而用户确实需要这句话才知道该去找管理员
        if lock_reason is not None:
            raise errors.AuthorizationError(msg=lock_reason)

        days_remaining = await password_security_service.check_password_expiry_status(
            db, user.last_password_changed_time
        )

        await password_security_service.handle_login_success(user.id)
        await password_security_service.handle_ip_login_success(ip)

        return user, days_remaining

    async def swagger_login(self, *, db: AsyncSession, obj: HTTPBasicCredentials) -> tuple[str, User]:
        """
        Swagger 文档登录

        :param db: 数据库会话
        :param obj: 登录凭证
        :return:
        """
        user, _ = await self.user_verify(db, obj.username, obj.password)
        await user_dao.update_login_time(db, obj.username)
        access_token_data = await create_access_token(
            user.id,
            multi_login=user.is_multi_login,
            # extra info
            swagger=True,
        )
        return access_token_data.access_token, user

    async def login(
        self,
        *,
        db: AsyncSession,
        response: Response,
        obj: AuthLoginParam,
        background_tasks: BackgroundTasks,
    ) -> GetLoginToken:
        """
        用户登录

        :param db: 数据库会话
        :param response: 响应对象
        :param obj: 登录参数
        :param background_tasks: 后台任务
        :return:
        """
        user = None
        try:
            await load_login_config(db)
            if settings.LOGIN_CAPTCHA_ENABLED:
                if not obj.uuid or not obj.captcha:
                    raise errors.RequestError(msg=t('error.captcha.invalid'))
                captcha_code = await redis_client.get(f'{settings.LOGIN_CAPTCHA_REDIS_PREFIX}:{obj.uuid}')
                if not captcha_code:
                    raise errors.RequestError(msg=t('error.captcha.expired'))
                if captcha_code.lower() != obj.captcha.lower():
                    raise errors.CustomError(error=CustomErrorCode.CAPTCHA_ERROR)
                await redis_client.delete(f'{settings.LOGIN_CAPTCHA_REDIS_PREFIX}:{obj.uuid}')

            user, days_remaining = await self.user_verify(db, obj.username, obj.password)
            await user_dao.update_login_time(db, obj.username)
            await db.refresh(user)
            access_token_data = await create_access_token(
                user.id,
                multi_login=user.is_multi_login,
                # extra info
                username=user.username,
                nickname=user.nickname,
                last_login_time=timezone.to_iso(user.last_login_time),
                ip=ctx.ip,
                os=ctx.os,
                browser=ctx.browser,
                device=ctx.device,
            )
            refresh_token_data = await create_refresh_token(
                access_token_data.session_uuid,
                user.id,
                multi_login=user.is_multi_login,
            )
            set_refresh_cookie(response, refresh_token_data.refresh_token, refresh_token_data.refresh_token_expire_time)
        except errors.BaseExceptionError as e:
            # 记录**所有**登录失败。
            #
            # 原实现只有 RequestError / CustomError（即验证码错误）会写日志，
            # 而 NotFoundError（用户名不存在）、AuthorizationError（密码错误）、
            # ForbiddenError（账号锁定）三类都被静默丢弃 —— 恰恰是安全审计最需要的：
            # 用户名探测和暴力破解在登录日志里完全不留痕迹。
            #
            # 这里把后台任务挂到**原异常**上再重新抛出，而不是包成 RequestError，
            # 这样 HTTP 状态码（404 / 403 / 401）与错误类型都保持不变。
            log.error(f'登陆错误: {e.msg}')
            e.background = BackgroundTask(
                login_log_service.create,
                user_uuid=user.uuid if user else uuid4_str(),
                username=obj.username,
                login_time=timezone.now(),
                status=LoginLogStatusType.fail.value,
                msg=e.msg,
            )
            raise
        except Exception as e:
            log.error(f'登陆错误: {e}')
            raise
        else:
            background_tasks.add_task(
                login_log_service.create,
                user_uuid=user.uuid,
                username=obj.username,
                login_time=timezone.now(),
                status=LoginLogStatusType.success.value,
                msg=t('success.login.success'),
            )
            data = GetLoginToken(
                access_token=access_token_data.access_token,
                access_token_expire_time=access_token_data.access_token_expire_time,
                session_uuid=access_token_data.session_uuid,
                password_expire_days_remaining=days_remaining,
                user=user,  # type: ignore
            )
            return data

    @staticmethod
    async def get_codes(*, db: AsyncSession, request: Request) -> list[str]:
        """
        获取用户权限码

        :param db: 数据库会话
        :param request: FastAPI 请求对象
        :return:
        """
        codes = set()
        if request.user.is_superuser:
            menus = await menu_dao.get_all(db, None, None)
            for menu in menus:
                if menu.status == StatusType.enable and menu.perms:
                    codes.update(menu.perms.split(','))
        else:
            roles = [role for role in request.user.roles if role.status == StatusType.enable]
            if roles:
                for role in roles:
                    for menu in role.menus:
                        if menu.status == StatusType.enable and menu.perms:
                            codes.update(menu.perms.split(','))

        return list(codes)

    @staticmethod
    async def refresh_token(*, db: AsyncSession, request: Request, response: Response) -> GetNewToken:
        """
        刷新令牌

        :param db: 数据库会话
        :param request: FastAPI 请求对象
        :param response: FastAPI 响应对象
        :return:
        """
        refresh_token = request.cookies.get(settings.COOKIE_REFRESH_TOKEN_KEY)
        if not refresh_token:
            raise errors.RequestError(msg=t('error.auth.refresh_token_expired'))

        token_payload = jwt_decode(refresh_token)
        user = await user_dao.get(db, token_payload.user_id)
        if not user:
            raise errors.NotFoundError(msg=t('error.user.not_found'))
        if not user.status:
            raise errors.AuthorizationError(msg=t('error.auth.account_locked'))
        token_keys = await redis_client.get_by_prefix(f'{settings.TOKEN_REDIS_PREFIX}:{user.id}')
        if not user.is_multi_login and [
            key for key in token_keys if not key.endswith(f':{token_payload.session_uuid}')
        ]:
            raise errors.ForbiddenError(msg=t('error.auth.duplicate_login'))
        new_token = await create_new_token(
            refresh_token,
            token_payload.session_uuid,
            user.id,
            multi_login=user.is_multi_login,
            # extra info
            username=user.username,
            nickname=user.nickname,
            last_login_time=timezone.to_iso(user.last_login_time),
            ip=ctx.ip,
            os=ctx.os,
            browser=ctx.browser,
            device_type=ctx.device,
        )
        set_refresh_cookie(response, new_token.new_refresh_token, new_token.new_refresh_token_expire_time)
        data = GetNewToken(
            access_token=new_token.new_access_token,
            access_token_expire_time=new_token.new_access_token_expire_time,
            session_uuid=new_token.session_uuid,
        )
        return data

    @staticmethod
    async def logout(*, request: Request, response: Response) -> None:
        """
        用户登出

        🔴 **会话身份从 access token 或 refresh cookie 里任取其一，不能只认前者。**
        原来这里第一句就是 `get_token(request)`，拿不到 `Authorization: Bearer` 直接
        `return` —— 于是两类调用方的登出**全都是空操作**，而两边都看不出来：

        - **桌面端**（`apps/desktop/src/main/auth.ts` 的 `logout`）只手工带 cookie、
          不带 Authorization（access token 在渲染层的 sessionStorage 里，主进程手上没有）。
          它本地删了凭据、界面也回到登录页，但服务端三个 key 一个没删 ——
          那个会话的 refresh token 还能再活 7 天
        refresh token 的 JWT 里同样带着 `sub` 和 `session_uuid`
        （`create_refresh_token`），所以它自己就够定位一个会话。安全性不受影响：
        没有任何一种凭据时什么都不做，拿得出凭据才撤销**它自己那一个**会话。

        ⚠️ 只带 cookie、不带 Authorization 的请求**本来就过得了 JWT 中间件** ——
        `extract_token()` 在没有 Authorization 头时返回 `None`，那是「未认证」不是
        「认证失败」。所以这个修复**不需要**把 `/auth/logout` 加进
        `TOKEN_REQUEST_PATH_EXCLUDE`（加了反而会让操作日志记不下用户名，见 conf.py 那条注释）。

        :param request: FastAPI 请求对象
        :param response: FastAPI 响应对象
        :return:
        """
        # 无论后面成不成，浏览器里那个 cookie 都要清掉
        response.delete_cookie(settings.COOKIE_REFRESH_TOKEN_KEY)

        identity: tuple[int, str] | None = None
        for candidate in (
            # access token 优先：它是「当前这次请求」最直接的身份
            lambda: get_token(request),
            lambda: request.cookies.get(settings.COOKIE_REFRESH_TOKEN_KEY) or '',
        ):
            try:
                payload = jwt_decode(candidate())
            except errors.TokenError:
                continue
            identity = (payload.user_id, payload.session_uuid)
            break

        if identity is None:
            # 两种凭据都没有或都无效 —— 登出本来就该是幂等的，静默成功
            return

        user_id, session_uuid = identity
        await revoke_token(user_id, session_uuid)
        # 🔴 见 issue #34：这份用户快照（menu_service.get_sidebar 用它筛菜单）原来
        # 只被 user_cache_manager.clear_* 显式作废，logout 从不碰它——一旦它被卡在
        # 旧值上（比如另一个管理员改权限的请求撞上了竞态），重新登录并不能重建它，
        # 用户能想到的所有恢复动作里，这是唯一真正有效的一个，必须补上。
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')


auth_service: AuthService = AuthService()
