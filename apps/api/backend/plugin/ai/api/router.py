from fastapi import APIRouter

from backend.core.conf import settings
from backend.plugin.ai.api.v1.chat import router as chat_router
from backend.plugin.ai.api.v1.conversation import router as conversation_router
from backend.plugin.ai.api.v1.mcp_client import router as mcp_client_router
from backend.plugin.ai.api.v1.provider import router as provider_router
from backend.plugin.ai.api.v1.tool import router as tool_router
from backend.plugin.ai.core.registry import load_builtin_tools

v1 = APIRouter(prefix=f'{settings.FASTAPI_API_V1_PATH}/ai')

v1.include_router(chat_router, prefix='/chat', tags=['AI 对话'])
v1.include_router(conversation_router, prefix='/conversations', tags=['AI 会话'])
v1.include_router(provider_router, prefix='/providers', tags=['AI 模型供应商'])
v1.include_router(tool_router, prefix='/tools', tags=['AI 工具'])
v1.include_router(mcp_client_router, prefix='/mcp-clients', tags=['AI MCP 凭据'])

# 在路由装配时把内置工具注册进来。
# ⚠️ 放这里而不是某个 startup 钩子：插件加载器一定会 import 这个模块，
# 而"没被 import 的工具等于不存在"的表现是模型答"我没有这个能力"——不报错。
load_builtin_tools()
