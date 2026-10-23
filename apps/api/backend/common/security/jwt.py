import time

from typing import Annotated, Any

from fastapi import Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.security.utils import get_authorization_scheme_param
from jose import ExpiredSignatureError, JWTError, jwt
from pydantic_core import from_json
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.authentication import UnauthenticatedUser

from backend.app.admin.model import User
from backend.app.admin.schema.user import GetUserInfoWithRelationDetail
from backend.common.context import ctx
from backend.common.dataclasses import AccessToken, TokenPayload
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.session import session_store
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.database.redis import redis_client
from backend.utils.timezone import timezone


def jwt_encode(payload: dict[str, Any]) -> str:
    """
    生成 JWT token

    :param payload: 载荷
    :return:
    """
    return jwt.encode(payload, settings.TOKEN_SECRET_KEY, settings.TOKEN_ALGORITHM)


def jwt_decode(token: str) -> TokenPayload:
    """
    解析 JWT token

    :param token: JWT token
    :return:
    """
    try:
        payload = jwt.decode(
            token,
            settings.TOKEN_SECRET_KEY,
            algorithms=[settings.TOKEN_ALGORITHM],
            options={'verify_exp': True},
        )
        session_uuid = payload.get('session_uuid')
        user_id = payload.get('sub')
        expire = payload.get('exp')
        if not session_uuid or not user_id or not expire:
            raise errors.TokenError(msg=t('error.token.invalid'))
    except ExpiredSignatureError:
        raise errors.TokenError(msg=t('error.token.expired'))
    except (JWTError, Exception):
        raise errors.TokenError(msg=t('error.token.invalid'))
    return TokenPayload(
        user_id=int(user_id),
        session_uuid=session_uuid,
        expire_time=timezone.from_datetime(timezone.to_utc(expire)),
    )


def issue_access_token(
    user_id: int, session_uuid: str, session_expire_at: int, *, lifetime: int | None = None
) -> AccessToken:
    """
    给一个会话签一枚 access token

    它不进 Redis：撤销靠「每个请求都核对会话还在不在」（`session_store.check`），
    不靠作废某一枚 token。所以同一个会话里可以同时有几枚有效的 access token（几个标签页各一枚），
    刷新也不用作废上一枚 —— 它本来就只活 `TOKEN_EXPIRE_SECONDS`

    :param user_id: 用户 ID
    :param session_uuid: 会话 ID（整个会话不变）
    :param session_expire_at: 会话的绝对到期（epoch 秒）—— access token 不能比会话活得长
    :param lifetime: 有效期秒数，默认 `TOKEN_EXPIRE_SECONDS`
    :return:
    """
    expire_at = min(int(time.time()) + (lifetime or settings.TOKEN_EXPIRE_SECONDS), session_expire_at)
    access_token = jwt_encode({'session_uuid': session_uuid, 'exp': expire_at, 'sub': str(user_id)})
    return AccessToken(
        access_token=access_token,
        access_token_expire_time=timezone.from_datetime(timezone.to_utc(expire_at)),
        session_uuid=session_uuid,
    )


def _cookie_secure(request: Request) -> bool:
    if settings.COOKIE_SECURE is not None:
        return settings.COOKIE_SECURE
    return request.url.scheme == 'https'


def _clear_legacy_refresh_cookie(response: Response) -> None:
    """清掉 #138 之前那个 `Path=/` 的 refresh cookie

    🔴 不清会怎样：浏览器访问 `/api/v1/auth/refresh` 时两个同名 cookie 都发（新的路径更长、排在前面），
    Starlette 解析 Cookie 头时**后出现的覆盖先出现的** —— 赢的是那个旧格式的、早已失效的值，
    于是每次刷新都 401，用户每 30 分钟被登出一次，持续到旧 cookie 自己过期（最长 7 天）。

    ⚠️ 必须排在真正下发的那一行**之后**：桌面端主进程按名字取**第一个** Set-Cookie
    （`apps/desktop/src/main/auth.ts: extractRefreshCookie`），排在前面它会存下一个空串。
    """
    response.delete_cookie(key=settings.COOKIE_REFRESH_TOKEN_KEY, path='/')


def set_refresh_cookie(response: Response, request: Request, refresh_token: str, expire_at: int) -> None:
    """把 refresh token 写进 HttpOnly cookie。

    🔴 **`max_age` 和 `expires` 必须来自同一个真相源**（会话的绝对到期）。#138 之前曾有一个独立配置
    `COOKIE_REFRESH_TOKEN_EXPIRE_SECONDS` 给 `max_age`，而按 RFC 6265 §5.3 `Max-Age` 优先于 `Expires` ——
    两个值配得不一致时，浏览器提前丢 cookie、服务端会话还在，静默早退。

    `Path` 限定在 `/api/v1/auth`：refresh token 只有登录 / 刷新 / 登出用得到，不该随每个请求一起发。
    `Secure` 见 `COOKIE_SECURE`。

    :param response: FastAPI 响应对象
    :param request: FastAPI 请求对象（判断是不是 HTTPS）
    :param refresh_token: `{sid}.{secret}`
    :param expire_at: 会话的绝对到期（epoch 秒）
    :return:
    """
    response.set_cookie(
        key=settings.COOKIE_REFRESH_TOKEN_KEY,
        value=refresh_token,
        max_age=max(expire_at - int(time.time()), 0),
        expires=timezone.to_utc(expire_at),
        path=settings.COOKIE_REFRESH_TOKEN_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite='lax',
    )
    _clear_legacy_refresh_cookie(response)


def clear_refresh_cookie(response: Response, request: Request) -> None:
    """登出：新旧两个路径上的 refresh cookie 都清掉"""
    response.delete_cookie(
        key=settings.COOKIE_REFRESH_TOKEN_KEY,
        path=settings.COOKIE_REFRESH_TOKEN_PATH,
        secure=_cookie_secure(request),
        httponly=True,
        samesite='lax',
    )
    _clear_legacy_refresh_cookie(response)


def get_token(request: Request) -> str:
    """
    获取请求头中的 token

    :param request: FastAPI 请求对象
    :return:
    """
    authorization = request.headers.get('Authorization')
    scheme, token = get_authorization_scheme_param(authorization)
    if not authorization or scheme.lower() != 'bearer':
        raise errors.TokenError(msg=t('error.token.invalid'))
    return token


async def get_current_user(db: AsyncSession, pk: int) -> User:
    """
    获取当前用户

    :param db: 数据库会话
    :param pk: 用户 ID
    :return:
    """
    from backend.app.admin.crud.crud_user import user_dao

    user = await user_dao.get_join(db, user_id=pk)
    if not user:
        raise errors.TokenError(msg=t('error.token.invalid'))
    if not user.status:
        raise errors.AuthorizationError(msg=t('error.auth.account_locked'))
    if user.dept_id and not user.dept:
        raise errors.AuthorizationError(msg=t('error.auth.dept_not_found'))
    if user.dept and not user.dept.status:
        raise errors.AuthorizationError(msg=t('error.auth.dept_locked'))
    if user.roles:
        role_status = [role.status for role in user.roles]
        if all(status == 0 for status in role_status):
            raise errors.AuthorizationError(msg=t('error.auth.role_locked'))
    return user


async def get_jwt_user(user_id: int) -> GetUserInfoWithRelationDetail:
    """
    获取 JWT 用户

    :param user_id:
    :return:
    """
    cache_user = await redis_client.get(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')
    if not cache_user:
        # 🔴 认证链路自己查用户必须豁免数据权限。这次读的目的不是「把数据展示给用户」，
        # 而是「弄清楚来的是谁」—— 按可见范围过滤会自锁：查不到自己 → 认证失败。
        # 多数时候这里 ContextVar 还是空的（用户还没解析出来），豁免是为了挡住
        # 「缓存恰好在一个已经设过用户的请求里过期并重建」这种时序。
        with bypass_data_scope():
            async with async_db_session() as db:
                current_user = await get_current_user(db, user_id)
            user = GetUserInfoWithRelationDetail.model_validate(current_user)
            await redis_client.set(
                f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}',
                user.model_dump_json(),
                ex=settings.TOKEN_EXPIRE_SECONDS,
            )
    else:
        # TODO: 在恰当的时机，应替换为使用 model_validate_json
        # https://docs.pydantic.dev/latest/concepts/json/#partial-json-parsing
        user = GetUserInfoWithRelationDetail.model_validate(from_json(cache_user, allow_partial=True))
    return user


async def jwt_authentication(
    token: str, *, client_idle: int | None = None, touch: bool = True
) -> GetUserInfoWithRelationDetail:
    """
    JWT 认证：验签 → 核对会话（还在不在 / 到期 / 空闲，顺手续活跃）→ 取用户

    :param token: access token
    :param client_idle: 客户端自报的「多少秒没操作了」（`X-Client-Idle`），见 `JwtAuthMiddleware.client_idle`
    :param touch: 这次请求算不算用户在操作；socket 握手传 False
    :return:
    """
    token_payload = jwt_decode(token)
    ctx.user_id = token_payload.user_id
    await session_store.check(
        user_id=token_payload.user_id,
        session_uuid=token_payload.session_uuid,
        client_idle=client_idle,
        touch=touch,
    )

    user = await get_jwt_user(ctx.user_id)
    ctx.is_superuser = user.is_superuser
    return user


def jwt_authentication_verify(
    request: Request,
    token: Annotated[HTTPAuthorizationCredentials, Depends(HTTPBearer())],
) -> str:
    """
    JWT 认证依赖

    :param request: FastAPI 请求对象
    :param token: HTTP Bearer 认证信息
    :return:
    """
    if isinstance(request.user, UnauthenticatedUser):
        if token_exception := ctx.get('__request_jwt_authentication_exception__'):
            raise token_exception
        raise errors.TokenError
    return token.credentials


# JWT 依赖注入
DependsJwtAuth = Depends(jwt_authentication_verify)


def superuser_verify(request: Request, _token: str = DependsJwtAuth) -> bool:
    """
    验证当前用户超级管理员权限

    :param request: FastAPI 请求对象
    :param _token: JWT 令牌
    :return:
    """
    if isinstance(request.user, UnauthenticatedUser):
        raise errors.TokenError

    superuser = request.user.is_superuser
    if not superuser or not request.user.is_staff:
        raise errors.AuthorizationError
    return superuser


# 超级管理员鉴权依赖注入
DependsSuperUser = Depends(superuser_verify)
