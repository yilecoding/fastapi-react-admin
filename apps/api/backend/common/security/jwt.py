import json
import uuid

from datetime import datetime, timedelta
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
from backend.common.dataclasses import AccessToken, NewToken, RefreshToken, TokenPayload
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.security.data_scope import bypass_data_scope
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


async def create_access_token(user_id: int, *, multi_login: bool, **kwargs) -> AccessToken:
    """
    生成加密 token

    :param user_id: 用户 ID
    :param multi_login: 是否允许多端登录
    :param kwargs: token 额外信息
    :return:
    """
    expire = timezone.now() + timedelta(seconds=settings.TOKEN_EXPIRE_SECONDS)
    session_uuid = str(uuid.uuid4())
    access_token = jwt_encode({
        'session_uuid': session_uuid,
        'exp': timezone.to_utc(expire).timestamp(),
        'sub': str(user_id),
    })

    if not multi_login:
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REDIS_PREFIX}:{user_id}')

    await redis_client.set(
        f'{settings.TOKEN_REDIS_PREFIX}:{user_id}:{session_uuid}',
        access_token,
        ex=settings.TOKEN_EXPIRE_SECONDS,
    )

    # Token 附加信息单独存储
    if kwargs:
        await redis_client.set(
            f'{settings.TOKEN_EXTRA_INFO_REDIS_PREFIX}:{user_id}:{session_uuid}',
            json.dumps(kwargs, ensure_ascii=False),
            ex=settings.TOKEN_EXPIRE_SECONDS,
        )

    return AccessToken(access_token=access_token, access_token_expire_time=expire, session_uuid=session_uuid)


async def create_refresh_token(session_uuid: str, user_id: int, *, multi_login: bool) -> RefreshToken:
    """
    生成加密刷新 token，仅用于创建新的 token

    :param session_uuid: 会话 UUID
    :param user_id: 用户 ID
    :param multi_login: 是否允许多端登录
    :return:
    """
    expire = timezone.now() + timedelta(seconds=settings.TOKEN_REFRESH_EXPIRE_SECONDS)
    refresh_token = jwt_encode({
        'session_uuid': session_uuid,
        'exp': timezone.to_utc(expire).timestamp(),
        'sub': str(user_id),
    })

    if not multi_login:
        await redis_client.delete_by_prefix(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user_id}')

    await redis_client.set(
        f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user_id}:{session_uuid}',
        refresh_token,
        ex=settings.TOKEN_REFRESH_EXPIRE_SECONDS,
    )
    return RefreshToken(refresh_token=refresh_token, refresh_token_expire_time=expire)


def set_refresh_cookie(response: Response, refresh_token: str, expire_time: datetime) -> None:
    """把 refresh token 写进 HttpOnly cookie。

    🔴 **`max_age` 和 `expires` 必须来自同一个真相源。** 三个调用点
    （`/auth/login`、`/auth/token/new`、oauth2 回调）原来各写一遍
    `set_cookie(...)`，而 `max_age` 取的是一个**独立配置**
    `COOKIE_REFRESH_TOKEN_EXPIRE_SECONDS`、`expires` 取的是 refresh token 的
    真实过期时间 —— 两个值可以不一致，而且**按 RFC 6265 §5.3，`Max-Age`
    优先于 `Expires`**，所以赢的是那个可能配错的。

    实测（把那个配置改成 60、refresh token 保持 604800）：同一个响应头里
    同时出现 `expires=Wed, 09 Sep 2026 ... GMT` 和 `Max-Age=60`。
    浏览器 60 秒后丢掉 cookie，而服务端那份 refresh token 还有 7 天 ——
    **静默早退，服务端完全观察不到**（Redis 里 token 还在、日志里什么都没有，
    用户只是「又被登出了」）。

    所以那个配置删了，`max_age` 直接从 `TOKEN_REFRESH_EXPIRE_SECONDS` 来 ——
    和 `expires` 同源，不可能再对不上。收成一个函数也是刻意的：
    三处各写一遍，迟早有一处和别人不一样（和 `file_ops.upload_root` 同一个理由）。

    :param response: FastAPI 响应对象
    :param refresh_token: 刷新令牌
    :param expire_time: 刷新令牌的过期时间（本地时区）
    :return:
    """
    response.set_cookie(
        key=settings.COOKIE_REFRESH_TOKEN_KEY,
        value=refresh_token,
        max_age=settings.TOKEN_REFRESH_EXPIRE_SECONDS,
        expires=timezone.to_utc(expire_time),
        httponly=True,
    )


async def create_new_token(
    refresh_token: str,
    session_uuid: str,
    user_id: int,
    *,
    multi_login: bool,
    **kwargs,
) -> NewToken:
    """
    生成新的 token

    :param refresh_token: 刷新 token
    :param session_uuid: 会话 UUID
    :param user_id: 用户 ID
    :param multi_login: 是否允许多端登录
    :param kwargs: token 附加信息
    :return:
    """
    redis_refresh_token = await redis_client.get(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user_id}:{session_uuid}')
    if not redis_refresh_token or redis_refresh_token != refresh_token:
        raise errors.TokenError(msg=t('error.auth.refresh_token_expired'))

    await redis_client.delete(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user_id}:{session_uuid}')
    await redis_client.delete(f'{settings.TOKEN_REDIS_PREFIX}:{user_id}:{session_uuid}')

    new_access_token = await create_access_token(user_id, multi_login=multi_login, **kwargs)
    new_refresh_token = await create_refresh_token(new_access_token.session_uuid, user_id, multi_login=multi_login)
    return NewToken(
        new_access_token=new_access_token.access_token,
        new_access_token_expire_time=new_access_token.access_token_expire_time,
        new_refresh_token=new_refresh_token.refresh_token,
        new_refresh_token_expire_time=new_refresh_token.refresh_token_expire_time,
        session_uuid=new_access_token.session_uuid,
    )


async def revoke_token(user_id: int, session_uuid: str) -> None:
    """
    撤销一个会话的**全部**凭据

    🔴 **三个 key 必须一起删，尤其是 refresh key。**
    原来这里只删 access（`TOKEN_REDIS_PREFIX`）和附加信息，漏了
    `TOKEN_REFRESH_REDIS_PREFIX` —— 而 `create_new_token()` 只校验
    「refresh key 存在且值相等」（jwt.py 里那两行），**从不检查 access key 还在不在**。
    于是「强制下线」（`api/v1/monitor/online.py` 的 `delete_session`）踢掉的会话，
    只要立刻打一次 `/auth/refresh` 就能换回一个全新的 access token；
    而此时 `token_keys` 恰好是空的，`multi_login` 那道检查反而更不会拦。
    表现是「在线用户页点了强制下线、那一行也消失了，人却还在」——
    界面上没有任何异常，被踢的人也毫无感觉。

    :param user_id: 用户 ID
    :param session_uuid: 会话 ID
    :return:
    """
    await redis_client.delete(f'{settings.TOKEN_REDIS_PREFIX}:{user_id}:{session_uuid}')
    await redis_client.delete(f'{settings.TOKEN_EXTRA_INFO_REDIS_PREFIX}:{user_id}:{session_uuid}')
    await redis_client.delete(f'{settings.TOKEN_REFRESH_REDIS_PREFIX}:{user_id}:{session_uuid}')


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


async def jwt_authentication(token: str) -> GetUserInfoWithRelationDetail:
    """
    JWT 认证

    :param token: JWT token
    :return:
    """
    token_payload = jwt_decode(token)
    ctx.user_id = token_payload.user_id
    redis_token = await redis_client.get(f'{settings.TOKEN_REDIS_PREFIX}:{ctx.user_id}:{token_payload.session_uuid}')
    if not redis_token:
        raise errors.TokenError(msg=t('error.token.expired'))

    if token != redis_token:
        raise errors.TokenError(msg=t('error.token.no_longer_valid'))

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
