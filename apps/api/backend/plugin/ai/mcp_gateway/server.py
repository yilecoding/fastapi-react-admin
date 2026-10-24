"""MCP 网关：把 `@ai_tool` 工具以 MCP（Streamable HTTP，无状态）开放给外部系统。

它是「入口可插拔」那一层的第二个入口（第一个是网页 SSE）。和网页入口一样，
**它不执行任何工具**：列清单用 `tool_dispatcher.visible_schemas()`，调用一律
`tool_dispatcher.dispatch()` —— 权限码、数据范围、审计和网页对话是同一份代码。

入口自己只多做两件事：

1. 鉴权（`auth.py`）：哪个系统、代表谁，**在 ASGI 外层做完**，失败直接回 HTTP 401/403，
   请求进不到 MCP 协议层；结果放进 `scope['state']`，处理函数从 `ctx.request.state` 读 ——
   不用 ContextVar，因为 MCP 的处理函数跑在会话管理器自己的任务组里，上下文传不过去
2. 只读：`RunContext(read_only=True)`，写操作由 dispatcher 拒绝并审计

无状态（`stateless=True` + JSON 响应）：每个请求独立鉴权，没有会话可劫持，多副本部署不用粘会话。
"""

from typing import Any

import mcp_types as types

from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPASGIApp, StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from pyrate_limiter import Duration, Rate
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from backend.common.exception import errors
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.plugin.ai.core.dispatcher import DispatchOutcome, tool_dispatcher
from backend.plugin.ai.core.permission import user_can
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import get_tool
from backend.plugin.ai.mcp_gateway.auth import McpAuthError, McpPrincipal, authenticate
from backend.utils.limiter import RateLimiter

_PRINCIPAL_KEY = 'ai_mcp_principal'

# MCP 调用没有「会话」，审计表的 conversation_id 是非空列，用 0 占位（雪花 ID 永远不会是 0）
NO_CONVERSATION = 0


def _principal(ctx: Any) -> McpPrincipal:
    # `request.state` 就是 `scope['state']`，外层 McpAuthGate 写进去的
    principal = getattr(ctx.request.state, _PRINCIPAL_KEY, None) if ctx.request is not None else None
    if principal is None:
        # 走到这里说明请求绕过了外层鉴权 —— 那是装配错误，宁可报错也不能当匿名放行
        raise RuntimeError('MCP 请求没有经过鉴权')
    return principal


async def _visible(principal: McpPrincipal) -> list[Any]:
    """调用者能看到的、这个入口开放的、这份凭据允许的 —— 三者取交集，只会越来越少"""
    off = await tool_dispatcher.off_plugins()
    return [
        schema
        for schema in tool_dispatcher.visible_schemas(principal.user, off)
        if (not schema.mutating or principal.client.allow_write) and principal.client.allows_tool(schema.name)
    ]


async def _list_tools(ctx: Any, _params: Any) -> types.ListToolsResult:
    return types.ListToolsResult(
        tools=[
            types.Tool(
                name=schema.name,
                description=schema.description,
                input_schema=schema.parameters,
                annotations=types.ToolAnnotations(read_only_hint=not schema.mutating),
            )
            for schema in await _visible(_principal(ctx))
        ]
    )


async def _call_tool(ctx: Any, params: types.CallToolRequestParams) -> types.CallToolResult:
    principal = _principal(ctx)
    # 凭据级的工具白名单在这里拦（权限码 / 只读由 dispatcher 拦并审计）
    if not principal.client.allows_tool(params.name):
        return types.CallToolResult(
            content=[types.TextContent(type='text', text=f'工具 {params.name} 不存在或这个凭据不能调用它。')],
            is_error=True,
        )

    spec = get_tool(params.name)
    if (
        spec is not None
        and spec.mutating
        and principal.client.allow_write
        and not user_can(principal.user, 'ai:chat:use')
    ):
        # 确认要在网页的 AI 助手里点，没有这个权限的人点不了 —— 发出去的链接会是一个死胡同
        return types.CallToolResult(
            content=[
                types.TextContent(
                    type='text',
                    text=f'{params.name} 需要 {principal.user.username} 本人在网页确认，'
                    '但他没有 AI 助手的使用权限（ai:chat:use），无法确认。请联系管理员授权。',
                )
            ],
            is_error=True,
        )

    async with async_db_session() as db:
        run_ctx = RunContext(
            user=principal.user,
            conversation_id=NO_CONVERSATION,
            db=db,
            provider=None,
            channel=principal.channel,
            # 没开 allow_write 的凭据：dispatcher 直接拒绝写操作并审计。开了也只走到预演 + 确认令牌
            read_only=not principal.client.allow_write,
        )
        outcome = await tool_dispatcher.dispatch(
            ToolCallRequest(call_id=f'mcp-{ctx.request_id}', name=params.name, arguments=params.arguments or {}),
            run_ctx,
        )
        # 只读工具不写业务数据，但审计行要落库
        await db.commit()
        await run_ctx.background_tasks()

    if outcome.kind == 'confirm_required':
        return types.CallToolResult(content=[types.TextContent(type='text', text=_confirm_text(principal, outcome))])
    return types.CallToolResult(
        content=[types.TextContent(type='text', text=outcome.payload)],
        is_error=outcome.kind != 'ok',
    )


def _confirm_text(principal: McpPrincipal, outcome: DispatchOutcome) -> str:
    """写操作只预演、不执行：把「会变成什么」和确认链接交给外部系统，由它转告用户。

    🔴 **确认必须回到我们自己的网页、由被代表的那个人本人登录后点。** MCP 客户端那一侧的
    确认（elicitation 的 form 模式）客户端可以代答，我们验证不了是人点的；而网页确认要求
    那个人的登录会话 —— 外部系统声明的身份，到这一步才被本人兑现。
    """
    minutes = max(settings.AI_CONFIRM_TOKEN_EXPIRE_SECONDS // 60, 1)
    link = f'{settings.AI_WEB_BASE_URL.rstrip("/")}/ai/confirm?token={outcome.confirm_token}'
    return (
        f'这个操作需要 {principal.user.username} 本人确认后才会执行，现在还没有执行。\n'
        f'将要执行：{outcome.preview}\n'
        f'请让 {principal.user.username} 在 {minutes} 分钟内打开下面的链接，登录后点「确认执行」：\n'
        f'{link}\n'
        '确认之前不要重复调用这个工具。'
    )


def build_server() -> Server[Any]:
    return Server(
        'fastapi-react-admin',
        instructions=(
            '后台管理系统的查询工具。所有调用以 X-Acting-User 指定的用户身份执行，'
            '只能看到该用户有权限的数据；ID 是字符串（雪花 ID），原样转述，不要做数值运算。'
        ),
        on_list_tools=_list_tools,
        on_call_tool=_call_tool,
    )


def build_session_manager() -> StreamableHTTPSessionManager:
    return StreamableHTTPSessionManager(
        app=build_server(),
        stateless=True,
        json_response=True,
        # ⚠️ 不关的话 SDK 按「本机服务」默认只认 localhost 的 Host 头，部署到真实域名后一律 421。
        # DNS rebinding 防的是「没有鉴权的本机服务被网页借道访问」，这里每个请求都要 Bearer 凭据
        security_settings=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )


def _client_identifier(request: Request) -> str:
    return f'ai-mcp:{getattr(request.state, _PRINCIPAL_KEY).client.id}'


# 一个额度一个限流器（RateLimiter 的桶键里带着额度，不同额度天然分开）
_limiters: dict[int, RateLimiter] = {}


async def _throttle(scope: Scope, receive: Receive, principal: McpPrincipal) -> int | None:
    """按凭据限流。超了返回 Retry-After 秒数，没超返回 None。

    复用全站的 `RateLimiter`（Redis 服务端时间、按标识分桶），所以它同样受
    `REQUEST_LIMITER_ENABLED` 管 —— 测试里默认关着，要验 429 用 `rate_limiter` fixture。
    """
    rate = principal.client.effective_rate
    limiter = _limiters.get(rate)
    if limiter is None:
        limiter = _limiters[rate] = RateLimiter(Rate(rate, Duration.MINUTE), identifier=_client_identifier)
    try:
        await limiter(Request(scope, receive), Response())
    except errors.HTTPError as e:
        return int((e.headers or {}).get('Retry-After', 60))
    return None


class McpAuthGate:
    """外层 ASGI：先鉴权，过了才交给 MCP；不过直接回 JSON 错误，不进协议层"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] != 'http':
            await self.app(scope, receive, send)
            return
        headers = {k.decode('latin-1').lower(): v.decode('latin-1') for k, v in scope.get('headers', [])}
        try:
            principal = await authenticate(headers)
        except McpAuthError as e:
            response = JSONResponse(
                {'error': e.message},
                status_code=e.status,
                headers={'WWW-Authenticate': 'Bearer'} if e.status == 401 else None,
            )
            await response(scope, receive, send)
            return
        scope.setdefault('state', {})[_PRINCIPAL_KEY] = principal
        # 限流在鉴权之后：要先知道是哪个系统才能按它计数；鉴权失败的请求本来就进不来
        retry_after = await _throttle(scope, receive, principal)
        if retry_after is not None:
            response = JSONResponse(
                {'error': f'请求过于频繁（每分钟 {principal.client.effective_rate} 次），请 {retry_after} 秒后再试'},
                status_code=429,
                headers={'Retry-After': str(retry_after)},
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def build_asgi_app(manager: StreamableHTTPSessionManager) -> ASGIApp:
    return McpAuthGate(StreamableHTTPASGIApp(manager))
