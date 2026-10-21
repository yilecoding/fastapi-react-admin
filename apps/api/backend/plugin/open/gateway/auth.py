"""开放接口的鉴权依赖：`dependencies=[DependsOpenApp('user:read', '读取用户')]`。

一个请求按这个顺序过（每一步失败给不同的错误码，对接文档里列着）：

1. 四个请求头齐全                                  `open.missing_param`      400
2. AK 对应的应用存在 / 启用 / 未过期                 `open.invalid_key` / `open.app_disabled` / `open.app_expired`  401
3. 来源 IP 在白名单内                               `open.ip_denied`          403
4. 时间戳与服务端相差不超过窗口                       `open.timestamp_expired`  401（回带服务端时间）
5. 签名正确                                        `open.sign_mismatch`      401（回带服务端的 StringToSign）
6. nonce 没用过                                    `open.nonce_reused`       401
7. 应用被授权调用这个接口                            `open.scope_denied`       403
8. 没超限流                                        `open.rate_limited`       429（Retry-After）

⚠️ **先验签、后消费 nonce**（和 #118 里的表顺序相反，刻意的）：签名不对的请求不该占掉一个 nonce ——
否则对方签错一次再修好重发，同一个 nonce 会被当成重放拒掉，对接时极难理解。真正的重放签名一定是对的，
照样撞上第 6 步。

数据范围：开放接口看**全量**，在这里显式 `bypass_data_scope()`，不靠「没有登录用户时 DAO 本来就不过滤」
这个隐含行为 —— 那个兜底哪天改成 fail-closed，开放接口会静默变成查不到数据。
数据边界靠两件事守：授权哪些接口（scope）+ 对外 schema 只放承诺给对方的字段。
"""

import ipaddress
import json
import time

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from fastapi import Request, Response
from pyrate_limiter import Duration, Rate
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.log import log
from backend.common.security.data_scope import bypass_data_scope
from backend.core.conf import settings
from backend.database.db import CurrentSession
from backend.database.redis import redis_client
from backend.plugin.open.crud.crud_app import open_app_dao
from backend.plugin.open.gateway import signature
from backend.plugin.open.gateway.errors import OpenApiError
from backend.plugin.open.model import OpenApp
from backend.utils.encrypt import AESCipher
from backend.utils.limiter import RateLimiter
from backend.utils.request_parse import get_request_ip
from backend.utils.timezone import timezone


@dataclass(slots=True)
class ScopeInfo:
    scope: str
    label: str
    method: str = ''
    path: str = ''


#: scope → 说明。`DependsOpenApp(...)` 构造时登记，管理页的勾选框和保存时的校验都读这一份 ——
#: 不另维护一份清单（两份迟早漂移，表现是能勾一个不存在的接口、或者新接口勾不到）
SCOPES: dict[str, ScopeInfo] = {}


@dataclass(slots=True)
class OpenCallContext:
    """一次开放接口调用里鉴权看到的东西，交给 `gateway/route.py` 落调用日志。

    失败也要能落：所以是一边校验一边往里填，而不是校验完了一次性生成。
    """

    access_key: str | None = None
    app: OpenApp | None = None
    scope: str | None = None
    scope_granted: bool | None = None
    ip_whitelisted: bool | None = None
    error_code: str = 'ok'
    row_count: int | None = None
    touch_last_used: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


CONTEXT_KEY = 'open_call'


def call_context(request: Request) -> OpenCallContext:
    ctx = getattr(request.state, CONTEXT_KEY, None)
    if ctx is None:
        ctx = OpenCallContext()
        setattr(request.state, CONTEXT_KEY, ctx)
    return ctx


def _cipher() -> AESCipher:
    key = settings.OPEN_SECRET_KEY
    if not key:
        # 管理端那边是「拒绝创建」；走到这里说明库里已经有应用、但部署时把密钥弄丢了 ——
        # 对调用方只能说服务端故障，原因写进服务端日志
        log.error('未配置 OPEN_SECRET_KEY，开放接口无法验签')
        raise errors.ServerError
    return AESCipher(key)


def _network(entry: str) -> ipaddress.IPv4Network | ipaddress.IPv6Network | None:
    try:
        return ipaddress.ip_network(entry, strict=False)
    except ValueError:
        return None


def ip_allowed(ip: str, whitelist: list[str] | None) -> bool:
    if not whitelist:
        return True
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(net is not None and addr in net for net in map(_network, whitelist))


def _parse_list(raw: str | None) -> list[str] | None:
    return json.loads(raw) if raw else None


# 一个额度一个限流器（RateLimiter 的桶键里带着额度，不同额度天然分开；同 MCP 网关）
_limiters: dict[int, RateLimiter] = {}


def _app_identifier(request: Request) -> str:
    return f'open-app:{call_context(request).app.id}'  # type: ignore[union-attr]


async def _throttle(request: Request, app: OpenApp) -> None:
    rate = app.rate_per_minute or settings.OPEN_RATE_PER_MINUTE
    limiter = _limiters.get(rate)
    if limiter is None:
        limiter = _limiters[rate] = RateLimiter(Rate(rate, Duration.MINUTE), identifier=_app_identifier)
    try:
        await limiter(request, Response())
    except errors.HTTPError as e:
        retry_after = str((e.headers or {}).get('Retry-After', 60))
        raise OpenApiError(429, 'open.rate_limited', headers={'Retry-After': retry_after}) from e


async def _consume_nonce(app: OpenApp, nonce: str) -> bool:
    key = f'{settings.OPEN_NONCE_REDIS_PREFIX}:{app.id}:{nonce}'
    return bool(await redis_client.set(key, '1', nx=True, ex=settings.OPEN_SIGN_WINDOW_SECONDS * 2))


async def _should_touch(app: OpenApp) -> bool:
    """「最近调用时间」一分钟最多写一次库：同步一跑就是一串翻页请求"""
    key = f'{settings.OPEN_LAST_USED_REDIS_PREFIX}:{app.id}'
    return bool(await redis_client.set(key, '1', nx=True, ex=60))


class DependsOpenApp:
    """开放接口的鉴权 + 授权依赖。每个 `/api/open/` 下的路由都必须挂它（有守卫测试）"""

    def __init__(self, scope: str, label: str) -> None:
        self.scope = scope
        SCOPES.setdefault(scope, ScopeInfo(scope=scope, label=label))

    async def __call__(self, request: Request, db: CurrentSession) -> AsyncIterator[OpenApp]:
        ctx = call_context(request)
        ctx.scope = self.scope
        app = await self._authenticate(request, db, ctx)

        ctx.scope_granted = self.scope in (_parse_list(app.scopes) or [])
        if not ctx.scope_granted:
            raise OpenApiError(403, 'open.scope_denied', scope=self.scope)

        await _throttle(request, app)
        ctx.touch_last_used = await _should_touch(app)

        with bypass_data_scope():
            yield app

    @staticmethod
    async def _authenticate(request: Request, db: AsyncSession, ctx: OpenCallContext) -> OpenApp:
        headers = request.headers
        access_key = headers.get(signature.HEADER_ACCESS_KEY)
        timestamp = headers.get(signature.HEADER_TIMESTAMP)
        nonce = headers.get(signature.HEADER_NONCE)
        sign = headers.get(signature.HEADER_SIGN)
        ctx.access_key = access_key
        missing = [
            name
            for name, value in (
                ('X-Access-Key', access_key),
                ('X-Timestamp', timestamp),
                ('X-Nonce', nonce),
                ('X-Sign', sign),
            )
            if not value
        ]
        if missing:
            raise OpenApiError(400, 'open.missing_param', headers_missing=', '.join(missing))

        # 配置读取，不是展示给某个人看的数据
        with bypass_data_scope():
            app = await open_app_dao.get_by_access_key(db, access_key)  # type: ignore[arg-type]
        if app is None:
            raise OpenApiError(401, 'open.invalid_key')
        ctx.app = app

        whitelist = _parse_list(app.ip_whitelist)
        ctx.ip_whitelisted = ip_allowed(get_request_ip(request), whitelist)

        if app.status != 1:
            raise OpenApiError(401, 'open.app_disabled')
        if expired(app):
            raise OpenApiError(401, 'open.app_expired', expire_time=timezone.to_str(app.expire_time))
        if not ctx.ip_whitelisted:
            raise OpenApiError(403, 'open.ip_denied', ip=get_request_ip(request))

        server_ms = int(time.time() * 1000)
        try:
            client_ms = int(timestamp)  # type: ignore[arg-type]
        except ValueError:
            client_ms = None
        window_ms = settings.OPEN_SIGN_WINDOW_SECONDS * 1000
        if client_ms is None or abs(server_ms - client_ms) > window_ms:
            raise OpenApiError(
                401,
                'open.timestamp_expired',
                data={'server_time': server_ms},
                window=settings.OPEN_SIGN_WINDOW_SECONDS,
            )

        expected = signature.string_to_sign(
            method=request.method,
            path=_raw_path(request),
            query=signature.canonical_query(request.query_params.multi_items()),
            timestamp=timestamp,  # type: ignore[arg-type]
            nonce=nonce,  # type: ignore[arg-type]
            body=await request.body(),
        )
        secret = _cipher().decrypt(bytes.fromhex(app.secret_cipher))
        if not signature.verify(secret, expected, sign):  # type: ignore[arg-type]
            # 回带服务端算出来的待签名字符串：它不含密钥，对方逐行一对就知道是路径、参数编码还是请求体不一样
            raise OpenApiError(401, 'open.sign_mismatch', data={'string_to_sign': expected})

        if not await _consume_nonce(app, nonce):  # type: ignore[arg-type]
            raise OpenApiError(401, 'open.nonce_reused')
        return app


def _raw_path(request: Request) -> str:
    """请求行里的路径，按发送时的原样（已编码的保持编码）。`url.path` 是解码过的"""
    raw = request.scope.get('raw_path')
    return raw.decode('latin-1') if raw else request.url.path


def expired(app: OpenApp, now: datetime | None = None) -> bool:
    return app.expire_time is not None and app.expire_time <= (now or timezone.now())
