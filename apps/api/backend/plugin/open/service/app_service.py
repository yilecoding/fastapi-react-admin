import json
import secrets

from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.routing import RouteContext, iter_route_contexts
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.plugin.open.crud.crud_app import open_app_dao
from backend.plugin.open.gateway.auth import SCOPES
from backend.plugin.open.model import OpenApp
from backend.plugin.open.schema.app import (
    CreateOpenAppParam,
    IssuedOpenSecret,
    OpenAppSchemaBase,
    OpenScopeItem,
    UpdateOpenAppParam,
)
from backend.utils.encrypt import AESCipher
from backend.utils.timezone import timezone

ACCESS_KEY_PREFIX = 'fra_ak_'
SECRET_KEY_PREFIX = 'fra_sk_'
OPEN_API_PREFIX = '/api/open/'


def _cipher() -> AESCipher:
    """取加密器。

    🔴 **没配密钥就拒绝，不静默存明文**（同 AI 供应商密钥）：「存了但没加密」在界面上和
    「存了且加密了」完全一样，等发现时密钥已经在库里躺了很久。
    """
    key = settings.OPEN_SECRET_KEY
    if not key:
        raise errors.ServerError(msg=t('error.open.secret_key_missing'))
    try:
        return AESCipher(key)
    except ValueError as e:
        raise errors.ServerError(msg=t('error.open.secret_key_invalid')) from e


def _issue_secret() -> tuple[str, str, str]:
    """→ (明文 SK, 密文 hex, 辨认用前缀)。明文只在调用方那一次响应里出现"""
    secret = f'{SECRET_KEY_PREFIX}{secrets.token_urlsafe(32)}'
    return secret, _cipher().encrypt(secret).hex(), f'{secret[: len(SECRET_KEY_PREFIX) + 4]}…'


def open_routes(app: FastAPI) -> list[RouteContext]:
    """所有开放接口的路由。

    🔴 不能直接遍历 `app.routes`：FastAPI 0.141 起 `include_router` 不再把子路由摊平，而是包成一层
    `_IncludedRouter` —— `app.routes` 里只看得见十来条顶层路由，开放接口一条都不在里面，
    清单和文档会静默变成空的。`iter_route_contexts` 是官方的展开方式（`get_openapi` 自己也用它）
    """
    return [r for r in iter_route_contexts(app.routes) if (r.path or '').startswith(OPEN_API_PREFIX)]


def state_of(status: int, expire_time: Any) -> str:
    if status != 1:
        return 'disabled'
    if expire_time is not None and expire_time <= timezone.now():
        return 'expired'
    return 'enabled'


def _check_scopes(obj: OpenAppSchemaBase) -> None:
    """写错的 scope 能存进去的话，表现是对方调那个接口永远 403，看起来像「密钥坏了」"""
    unknown = [s for s in obj.scopes if s not in SCOPES]
    if unknown:
        raise errors.RequestError(msg=t('error.open.scope_unknown', scopes='、'.join(unknown)))


def _columns(obj: OpenAppSchemaBase) -> dict[str, Any]:
    data = obj.model_dump()
    data['scopes'] = json.dumps(obj.scopes, ensure_ascii=False)
    data['ip_whitelist'] = json.dumps(obj.ip_whitelist, ensure_ascii=False) if obj.ip_whitelist else None
    return data


class OpenAppService:
    """能力开放应用管理"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> dict[str, Any]:
        obj = await open_app_dao.get(db, pk)
        if not obj:
            raise errors.NotFoundError(msg=t('error.open.app_not_found'))
        detail = {c.name: getattr(obj, c.name) for c in OpenApp.__table__.columns}
        detail['state'] = state_of(obj.status, obj.expire_time)
        return detail

    @staticmethod
    async def get_list(*, db: AsyncSession, name: str | None, status: int | None) -> dict[str, Any]:
        data = await paging_data(db, await open_app_dao.get_select(name=name, status=status))
        for item in data['items']:
            item['state'] = state_of(item['status'], item['expire_time'])
        return data

    @staticmethod
    def get_scopes(app: FastAPI) -> list[OpenScopeItem]:
        """可授权的接口清单：scope 来自 `DependsOpenApp` 的登记，路径和方法从路由上找回来"""
        where: dict[str, tuple[str, str]] = {}
        for route in open_routes(app):
            for dep in route.dependencies or []:
                scope = getattr(dep.dependency, 'scope', None)
                if scope:
                    where[scope] = (','.join(sorted(route.methods or [])), route.path or '')
        return [
            OpenScopeItem(
                scope=s.scope,
                label=s.label,
                method=where.get(s.scope, ('', ''))[0],
                path=where.get(s.scope, ('', ''))[1],
            )
            for s in SCOPES.values()
        ]

    @staticmethod
    async def create(*, db: AsyncSession, obj: CreateOpenAppParam, user_id: int) -> IssuedOpenSecret:
        if await open_app_dao.get_by_code(db, obj.code):
            raise errors.ConflictError(msg=t('error.open.code_exists', code=obj.code))
        _check_scopes(obj)
        secret, cipher, hint = _issue_secret()
        access_key = f'{ACCESS_KEY_PREFIX}{secrets.token_urlsafe(18)}'
        row = OpenApp(
            **_columns(obj),
            access_key=access_key,
            secret_cipher=cipher,
            secret_hint=hint,
            created_by=user_id,
        )
        db.add(row)
        await db.flush()
        return IssuedOpenSecret(id=row.id, code=row.code, access_key=access_key, secret_key=secret)

    @staticmethod
    async def update(*, db: AsyncSession, pk: int, obj: UpdateOpenAppParam) -> None:
        row = await open_app_dao.get(db, pk)
        if not row:
            raise errors.NotFoundError(msg=t('error.open.app_not_found'))
        _check_scopes(obj)
        for key, value in _columns(obj).items():
            setattr(row, key, value)

    @staticmethod
    async def reset_secret(*, db: AsyncSession, pk: int) -> IssuedOpenSecret:
        """换一个新 SK，旧的立即失效。AK 不变 —— 对方只用改一个配置项"""
        row = await open_app_dao.get(db, pk)
        if not row:
            raise errors.NotFoundError(msg=t('error.open.app_not_found'))
        secret, cipher, hint = _issue_secret()
        row.secret_cipher, row.secret_hint = cipher, hint
        return IssuedOpenSecret(id=row.id, code=row.code, access_key=row.access_key, secret_key=secret)

    @staticmethod
    async def delete(*, db: AsyncSession, pk: int) -> int:
        return await open_app_dao.delete(db, pk)

    @staticmethod
    def openapi(app: FastAPI) -> dict[str, Any]:
        """只含开放接口的 OpenAPI 文档，给对接方。

        生产环境的 `/openapi` 是关的（`FASTAPI_OPENAPI_URL = None`），所以这份放在后台里、
        登录且有 `open:app:list` 才能拿到，不对公网暴露。
        """
        return get_openapi(
            title='开放接口',
            version='v1',
            description=(
                '每个请求带 X-Access-Key / X-Timestamp（毫秒）/ X-Nonce / X-Sign 四个请求头，'
                '签名算法 FRA1-HMAC-SHA256，见对接文档（plugin/open/README.md）。'
                'ID 一律是字符串，时间一律是带时区的 ISO 8601。'
            ),
            routes=open_routes(app),
        )


open_app_service: OpenAppService = OpenAppService()
