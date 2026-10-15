"""进程内的 OpenAI 兼容 function-calling 引擎。

它是 `AgentRuntimePort` 的**第一个**实现，也是兜底实现：不依赖任何外部进程，
装完插件就能跑。要换成 pi sidecar 之类，照着这个文件的形状再写一个适配器、
把 `AI_AGENT_ENGINE` 指过去即可，业务代码一行不用改。

⚠️ 它**刻意不做**上下文压缩 / 检查点 / 断点续跑。这些是长会话（几小时的编码会话）
才需要的能力，后台操作对话三五轮就结束，为它们付复杂度不划算；真需要的那天，
正确的做法是接一个已经做好这些的引擎（那正是可插拔架构存在的理由），
而不是在这里慢慢长出一个半成品。
"""

import json

from collections.abc import AsyncIterator
from typing import Any

from backend.common.log import log
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.events import (
    AgentEvent,
    ConfirmRequiredEvent,
    DeltaEvent,
    DoneEvent,
    ErrorEvent,
    ToolCallEvent,
    ToolResultEvent,
    UsageEvent,
)
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest, ToolSchema
from backend.plugin.ai.llm.client import OpenAICompatClient, accumulate_tool_calls


def to_openai_tools(tools: list[ToolSchema]) -> list[dict[str, Any]]:
    """`ToolSchema` → OpenAI function 定义。

    这层翻译是**适配器的责任**，不是工具作者的。工具作者写的永远是 `@ai_tool`，
    换引擎时只有这个函数要重写。
    """
    return [
        {
            'type': 'function',
            'function': {
                'name': spec.name,
                'description': spec.description,
                'parameters': spec.parameters,
            },
        }
        for spec in tools
    ]


class NativeLoopEngine:
    """OpenAI 兼容的多轮 function-calling 循环"""

    name = 'native'

    def __init__(self, client: OpenAICompatClient) -> None:
        self._client = client

    async def run(  # ruff: ignore[complex-structure]
        self,
        history: list[dict[str, Any]],
        tools: list[ToolSchema],
        ctx: RunContext,
    ) -> AsyncIterator[AgentEvent]:
        messages = list(history)
        tool_defs = to_openai_tools(tools)
        final_text: list[str] = []

        for round_index in range(ctx.max_tool_rounds):
            text_parts: list[str] = []
            tool_buffer: dict[int, dict[str, Any]] = {}

            try:
                async for delta in self._client.stream_chat(messages, tool_defs):
                    if delta.text:
                        text_parts.append(delta.text)
                        yield DeltaEvent(text=delta.text)
                    if delta.tool_calls:
                        accumulate_tool_calls(tool_buffer, delta.tool_calls)
                    if delta.usage:
                        yield UsageEvent(**delta.usage)
            except Exception as e:
                log.exception('AI 引擎调用模型失败')
                yield ErrorEvent(message=str(e), code='llm_error')
                return

            assistant_text = ''.join(text_parts)
            if assistant_text:
                final_text.append(assistant_text)

            # 没有工具调用 = 这一轮就是最终回答
            if not tool_buffer:
                yield DoneEvent()
                return

            calls = [
                ToolCallRequest(
                    call_id=slot['id'] or f'call_{round_index}_{index}',
                    name=slot['name'],
                    arguments=_safe_json(slot['arguments']),
                )
                for index, slot in sorted(tool_buffer.items())
            ]

            # 把助手这一轮的提议原样放回历史 —— 少了它，下一轮发给模型的消息里
            # 会出现「凭空冒出来的 tool 结果」，多数网关直接报 400
            messages.append({
                'role': 'assistant',
                'content': assistant_text or None,
                'tool_calls': [
                    {
                        'id': call.call_id,
                        'type': 'function',
                        'function': {'name': call.name, 'arguments': json.dumps(call.arguments, ensure_ascii=False)},
                    }
                    for call in calls
                ],
            })

            paused_for_confirm = False
            for call in calls:
                yield ToolCallEvent(call_id=call.call_id, name=call.name, arguments=call.arguments)

                outcome = await tool_dispatcher.dispatch(call, ctx)

                if outcome.kind == 'confirm_required':
                    yield ConfirmRequiredEvent(
                        token=outcome.confirm_token or '',
                        name=call.name,
                        preview=outcome.preview or '',
                        arguments=call.arguments,
                    )
                    paused_for_confirm = True
                else:
                    yield ToolResultEvent(
                        call_id=call.call_id,
                        name=call.name,
                        ok=outcome.kind == 'ok',
                        summary=outcome.summary,
                        perm=outcome.perm,
                        duration_ms=outcome.duration_ms,
                    )

                messages.append({'role': 'tool', 'tool_call_id': call.call_id, 'content': outcome.payload})

            # 有待确认的调用就停在这里：继续问模型只会让它对着一个还没发生的结果编下文。
            # 用户点确认后由 `/ai/tools/confirm` 那条路继续。
            if paused_for_confirm:
                yield DoneEvent()
                return

        # 轮数用尽。这是**正常的保护**不是异常，但必须让用户看见 ——
        # 否则表现是"AI 查了一堆东西然后没下文"（硬纪律 9）
        log.warning(f'AI 对话达到最大工具调用轮数 {ctx.max_tool_rounds}')
        yield ErrorEvent(
            message=f'已达到单轮最多 {ctx.max_tool_rounds} 次工具调用的上限，请把问题拆小一些再问。',
            code='max_rounds',
        )


def _safe_json(raw: str) -> dict[str, Any]:
    """模型给的 arguments 是字符串，且**经常不是合法 JSON**。

    解析失败不抛异常：返回空参数让工具自己的签名校验去报错，
    那条路径上的错误信息（"缺少必填参数 x"）比 "JSONDecodeError" 对模型有用得多 ——
    模型看到后会重填，看到 JSONDecodeError 只会重复同样的错误。
    """
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning(f'模型给的工具参数不是合法 JSON，已按空参数处理：{raw[:200]}')
        return {}
    return parsed if isinstance(parsed, dict) else {}
