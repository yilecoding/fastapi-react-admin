"""插件钩子：把 MCP 网关挂到主应用上。

🔴 MCP 的会话管理器有自己的生命周期（`manager.run()`），而 **mount 进来的子应用的
lifespan 不会被执行** —— 漏了的表现是第一个请求就 `Task group is not initialized`。
所以由这里的 `lifespan` 在主应用启动时显式拉起。

网关始终挂上，开关 `AI_MCP_ENABLED` 在每个请求上判（关着就是 404）：改配置不用重启进程也能
关掉，测试里也能直接打开。
"""

import re

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from starlette.routing import Route

from backend.core.conf import settings

MCP_PATH = f'{settings.FASTAPI_API_V1_PATH}/ai/mcp'


def setup(app: FastAPI) -> None:
    from backend.plugin.ai.mcp_gateway.server import build_asgi_app, build_session_manager

    manager = build_session_manager()
    app.state.ai_mcp_manager = manager
    # ⚠️ 用精确路径的 Route，不用 `app.mount`：mount 只认 `MCP_PATH/…`，不带斜杠的
    # `MCP_PATH` 会被 307 重定向，而 MCP 客户端多数直接 POST 配置的 URL、不跟重定向。
    # Route 的 endpoint 不是函数时按原生 ASGI 应用调用
    app.router.routes.append(Route(MCP_PATH, endpoint=build_asgi_app(manager), methods=['GET', 'POST', 'DELETE']))
    # 外部系统的 Bearer 是我们自己的 M2M 凭据，不是 JWT。不放行的话 JWT 中间件会先把它当
    # 一个坏 JWT 拒掉（401「token 无效」），请求根本到不了网关的鉴权
    pattern = re.compile(rf'^{re.escape(MCP_PATH)}$')
    if not any(p.pattern == pattern.pattern for p in settings.TOKEN_REQUEST_PATH_EXCLUDE_PATTERN):
        settings.TOKEN_REQUEST_PATH_EXCLUDE_PATTERN.append(pattern)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    manager = getattr(app.state, 'ai_mcp_manager', None)
    if manager is None:
        yield
        return
    async with manager.run():
        yield
