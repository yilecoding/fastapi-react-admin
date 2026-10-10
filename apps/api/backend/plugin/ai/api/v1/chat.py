from fastapi import APIRouter, Depends, Request
from starlette.responses import StreamingResponse

from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.plugin.ai.schema.conversation import ChatParam, ConfirmToolParam
from backend.plugin.ai.service.chat_service import chat_service

router = APIRouter()

# SSE 的响应头在第一个字节发出时就定死了，流中途失败**改不了状态码**。
# 所以这两条路由的错误一律走 `type: "error"` 事件帧，前端只认那个（见 core/events.py）。
_SSE_HEADERS = {
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    # 关掉 nginx 的响应缓冲。不关的话 nginx 会攒够一块才转发，
    # 表现是"等好几秒，然后整段话一次性蹦出来"——功能是好的，但流式的意义没了
    'X-Accel-Buffering': 'no',
}


@router.post(
    '/stream',
    summary='发起一轮对话（SSE 流式）',
    # ⚠️ 挂 `DependsRBAC` 的副作用：`rbac_verify` 对非 GET 请求额外要求 `is_staff`，
    # 所以非后台管理用户即使有 `ai:chat:use` 也进不来。这是**刻意接受**的一致性——
    # 全站所有挂了 RBAC 的写接口都是这个门槛，为 AI 破例会多出一条只有这里成立的规则。
    dependencies=[Depends(RequestPermission('ai:chat:use')), DependsRBAC],
)
async def chat_stream(request: Request, obj: ChatParam) -> StreamingResponse:
    return StreamingResponse(
        chat_service.stream(user=request.user, conversation_id=obj.conversation_id, content=obj.content),
        media_type='text/event-stream',
        headers=_SSE_HEADERS,
    )


@router.post(
    '/tools/confirm',
    summary='确认执行一个变更类工具（SSE 流式）',
    dependencies=[Depends(RequestPermission('ai:chat:use')), DependsRBAC],
)
async def confirm_tool(request: Request, obj: ConfirmToolParam) -> StreamingResponse:
    return StreamingResponse(
        chat_service.confirm_tool(user=request.user, token=obj.token),
        media_type='text/event-stream',
        headers=_SSE_HEADERS,
    )
