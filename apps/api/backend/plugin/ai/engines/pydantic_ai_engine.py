"""pydantic-ai 引擎 —— `AgentRuntimePort` 的第二个实现（`AI_AGENT_ENGINE = "pydantic_ai"`）。

它证明的是「换引擎只改一个配置值」这句话：工具、权限、确认、审计、前端一行不动。

🔴 **工具一律以 `ExternalToolset` 交给框架**：框架只知道工具叫什么、参数长什么样，
模型提议的调用由 `HandleDeferredToolCalls` 交回这里，再经 `tool_dispatcher.dispatch`
执行 —— 和 native 引擎走的是同一条咽喉。**不要**图省事改成 `Agent(tools=[...])` /
`FunctionToolset`：那样框架会自己执行工具，权限码 / 数据范围 / 二次确认 / 审计全部跳过，
而且不报任何错（spike 实测过，守卫见 `tests/test_ai_security.py::TestEnginesNeverHoldExecutables`）。

二次确认继续归 dispatcher：`confirm_required` 的调用**不回填结果**，框架把它当成
「还没算完的外部调用」冒泡出来、结束这一轮 —— 和 native 引擎「停在确认卡片上」同一个语义。
⚠️ 别换成框架自带的 `requires_approval`：它对 external 工具不可用（实测 RuntimeError），
而且确认令牌 / 预演 / 归属校验都在 dispatcher 那一侧。

实测出来的四个坑，各有一处对应的处理（`tests/test_ai_pydantic_engine.py` 逐条守着）：

| 坑 | 不处理的表现 | 处理 |
|---|---|---|
| `ExternalToolset` 把重试写死成 0 | 一次坏 JSON 整轮报错 | `_RetryingExternalToolset` 放宽 |
| 一个片段的首段文字在 `PartStartEvent` 里，不在 delta 里 | 每段回答**静默丢掉开头几个字** | 两种事件都取文字 |
| `tool_calls_limit` 不计 external 调用 | 「最多 N 轮」形同虚设 | 用 `request_limit` |
| 首次运行往终端打一大块 banner | 服务日志里混进一幅 ASCII 画 | 关掉 `BANNER_ENABLED` |
"""

import json

from collections.abc import AsyncIterator
from dataclasses import replace
from typing import Any

import httpx2
import pydantic_ai

from openai import AsyncOpenAI
from pydantic_ai import Agent, AgentRunResultEvent
from pydantic_ai.capabilities import HandleDeferredToolCalls
from pydantic_ai.exceptions import UsageLimitExceeded
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    PartDeltaEvent,
    PartStartEvent,
    TextPart,
    TextPartDelta,
    UserPromptPart,
)
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.tools import DeferredToolRequests, DeferredToolResults, ToolDefinition
from pydantic_ai.toolsets import ExternalToolset
from pydantic_ai.usage import UsageLimits

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
from backend.plugin.ai.llm.client import OpenAICompatClient

# 服务进程的输出归我们管。它只在第一次运行时打一次，但那一次正好落在生产日志里
pydantic_ai.BANNER_ENABLED = False

# 模型给了坏参数时允许它重来几次。框架会把「参数不是合法 JSON」作为重试提示回给模型 ——
# 比 native 引擎「按空参数执行、让签名校验去报错」更直接
_TOOL_RETRIES = 2


class _RetryingExternalToolset(ExternalToolset[Any]):
    """`ExternalToolset`，只改一处：重试次数。

    上游把 `max_retries` 写死成 0（`toolsets/external.py`），于是模型一次参数 JSON
    没写完整，框架就抛 `UnexpectedModelBehavior`、整轮对话报错 —— 而这在
    小模型 / 内网网关上是常态。`call_tool` 照旧 `NotImplementedError`：
    这个 toolset 依然**执行不了任何东西**。
    """

    async def get_tools(self, ctx: Any) -> dict[str, Any]:
        tools = await super().get_tools(ctx)
        return {name: replace(tool, max_retries=_TOOL_RETRIES) for name, tool in tools.items()}


def to_tool_definitions(tools: list[ToolSchema]) -> list[ToolDefinition]:
    """`ToolSchema` → pydantic-ai 的 `ToolDefinition`（同 native 的 `to_openai_tools`，适配器的责任）"""
    return [
        ToolDefinition(name=spec.name, description=spec.description, parameters_json_schema=spec.parameters)
        for spec in tools
    ]


def build_model(client: OpenAICompatClient) -> Model:
    """沿用供应商配置里的同一套连接参数。

    ⚠️ openai 3.x 用的是 `httpx2`（不是 `httpx`），所以那两条内网约束要在**这一个**
    客户端上重新声明一遍，漏了的失败方式见 `llm/client.py` 开头 —— 都长得像「网关挂了」。
    走 Chat Completions（`OpenAIChatModel`）而不是 Responses API：内网 OpenAI 兼容网关
    基本只实现了前者。
    """
    http_client = httpx2.AsyncClient(
        verify=client.verify_ssl,
        trust_env=client.use_proxy,
        timeout=httpx2.Timeout(client.timeout, connect=min(30, client.timeout)),
    )
    # 重试交给我们自己的失败语义（错误帧），不让 SDK 在背后把一个 120 秒的超时再重来两遍
    openai_client = AsyncOpenAI(
        base_url=client.base_url, api_key=client.api_key, http_client=http_client, max_retries=0
    )
    return OpenAIChatModel(client.model, provider=OpenAIProvider(openai_client=openai_client))


def split_history(history: list[dict[str, Any]]) -> tuple[str | None, list[ModelMessage], str]:
    """OpenAI 形状的历史 → (instructions, 之前的消息, 本次用户输入)。

    `chat_service._build_history` 只放 system / user / assistant 三种角色的正文
    （不回放工具调用），所以这里也只需要翻译这三种。
    """
    instructions = '\n\n'.join(m['content'] for m in history if m['role'] == 'system' and m.get('content')) or None
    turns = [m for m in history if m['role'] in ('user', 'assistant')]
    if not turns or turns[-1]['role'] != 'user':
        raise ValueError('对话历史的最后一条必须是本次的用户输入')

    previous: list[ModelMessage] = []
    for message in turns[:-1]:
        if message['role'] == 'user':
            previous.append(ModelRequest(parts=[UserPromptPart(content=message['content'])]))
        else:
            previous.append(ModelResponse(parts=[TextPart(content=message['content'])]))
    return instructions, previous, turns[-1]['content']


def _parse_args(args: str | dict[str, Any] | None) -> dict[str, Any]:
    """走到这里的参数已经过了框架的 JSON 校验（坏 JSON 在前面就被打回去重试了），
    但仍可能是「合法 JSON、却不是对象」。和 native 一样不抛，交给工具签名去报错"""
    if isinstance(args, dict):
        return args
    if not args:
        return {}
    try:
        parsed = json.loads(args)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


class PydanticAIEngine:
    """pydantic-ai 驱动的多轮 function-calling，工具执行仍走 dispatcher"""

    name = 'pydantic_ai'

    def __init__(self, client: OpenAICompatClient, *, model: Model | None = None) -> None:
        # `model` 只给测试注入 `FunctionModel` 用；线上一律从供应商配置构造
        self._model = model or build_model(client)

    async def run(  # ruff: ignore[complex-structure]
        self,
        history: list[dict[str, Any]],
        tools: list[ToolSchema],
        ctx: RunContext,
    ) -> AsyncIterator[AgentEvent]:
        instructions, previous, prompt = split_history(history)

        # handler 跑在框架的事件循环**里面**，没法直接 yield。它产出的事件先进这个缓冲，
        # 由外层在下一个框架事件到来时（就是紧随其后的 DeferredToolResultsEvent）冲出去
        pending: list[AgentEvent] = []

        async def handle(_run_ctx: Any, requests: DeferredToolRequests) -> DeferredToolResults:
            results: dict[str, Any] = {}
            for part in requests.calls:
                call = ToolCallRequest(call_id=part.tool_call_id, name=part.tool_name, arguments=_parse_args(part.args))
                pending.append(ToolCallEvent(call_id=call.call_id, name=call.name, arguments=call.arguments))

                outcome = await tool_dispatcher.dispatch(call, ctx)

                if outcome.kind == 'confirm_required':
                    # 不回填 = 留给框架冒泡成 DeferredToolRequests、结束这一轮。
                    # 继续问模型只会让它对着一个还没发生的结果编下文
                    pending.append(
                        ConfirmRequiredEvent(
                            token=outcome.confirm_token or '',
                            name=call.name,
                            preview=outcome.preview or '',
                            arguments=call.arguments,
                        )
                    )
                    continue
                pending.append(
                    ToolResultEvent(
                        call_id=call.call_id,
                        name=call.name,
                        ok=outcome.kind == 'ok',
                        summary=outcome.summary,
                        perm=outcome.perm,
                        duration_ms=outcome.duration_ms,
                    )
                )
                results[call.call_id] = outcome.payload
            return DeferredToolResults(calls=results)

        agent = Agent(
            self._model,
            instructions=instructions,
            toolsets=[_RetryingExternalToolset(to_tool_definitions(tools))],
            output_type=[str, DeferredToolRequests],
            capabilities=[HandleDeferredToolCalls(handler=handle)],
            model_settings={'temperature': 0.3},
        )

        try:
            async with agent.run_stream_events(
                prompt,
                message_history=previous,
                # 🔴 不能用 `tool_calls_limit`：它不计 external 调用（实测），设了等于没设。
                # 一次模型请求 = native 引擎的一「轮」
                usage_limits=UsageLimits(request_limit=ctx.max_tool_rounds),
            ) as stream:
                async for event in stream:
                    while pending:
                        yield pending.pop(0)

                    # 🔴 两种都要取：一段文字的**开头**在 PartStartEvent 里（实测），
                    # 只处理 delta 的话每段回答都静默少掉前几个字
                    if isinstance(event, PartStartEvent) and isinstance(event.part, TextPart):
                        if event.part.content:
                            yield DeltaEvent(text=event.part.content)
                    elif isinstance(event, PartDeltaEvent) and isinstance(event.delta, TextPartDelta):
                        if event.delta.content_delta:
                            yield DeltaEvent(text=event.delta.content_delta)
                    elif isinstance(event, AgentRunResultEvent):
                        # 2.57 起 `usage` 从方法改成了属性；Python 3.10 只装得到 2.54（见 pyproject 那行注释）
                        usage = event.result.usage
                        usage = usage() if callable(usage) else usage
                        yield UsageEvent(prompt_tokens=usage.input_tokens, completion_tokens=usage.output_tokens)
        except UsageLimitExceeded:
            while pending:
                yield pending.pop(0)
            # 和 native 同一句话、同一个 code：前端只认 code，不该知道是哪个引擎
            log.warning(f'AI 对话达到最大工具调用轮数 {ctx.max_tool_rounds}')
            yield ErrorEvent(
                message=f'已达到单轮最多 {ctx.max_tool_rounds} 次工具调用的上限，请把问题拆小一些再问。',
                code='max_rounds',
            )
            return
        except Exception as e:
            while pending:
                yield pending.pop(0)
            log.exception('AI 引擎（pydantic-ai）运行失败')
            yield ErrorEvent(message=str(e), code='llm_error')
            return

        while pending:
            yield pending.pop(0)
        yield DoneEvent()
