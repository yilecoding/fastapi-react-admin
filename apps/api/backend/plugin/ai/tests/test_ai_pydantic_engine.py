"""pydantic-ai 引擎的守卫测试。

用框架自带的 `FunctionModel` 当模型（不连网关），dispatcher 换成记账的假实现 ——
这里测的是**适配层**：事件翻译、工具交回 dispatcher、确认时停下、四个实测坑。
dispatcher 本身的权限 / 范围 / 确认在 `test_ai_security.py` / `test_ai_write_tools.py`。

最后一组拿同一段对话分别喂给 native 和 pydantic-ai，断言两边产出的事件序列一致 ——
「换引擎前端一行不动」靠的就是这一条。
"""

import asyncio
import json

from collections.abc import AsyncIterator
from types import SimpleNamespace
from typing import Any

import pytest

from pydantic_ai.messages import ModelMessage, ModelRequest, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel

from backend.plugin.ai.core.dispatcher import DispatchOutcome, tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolSchema
from backend.plugin.ai.engines import registry as engine_registry
from backend.plugin.ai.engines.native import NativeLoopEngine
from backend.plugin.ai.engines.pydantic_ai_engine import PydanticAIEngine, split_history
from backend.plugin.ai.llm.client import OpenAICompatClient, StreamDelta

_TOOLS = [
    ToolSchema(
        name='dept_list',
        description='查部门',
        parameters={'type': 'object', 'properties': {'name': {'type': 'string'}}},
    )
]
_HISTORY = [
    {'role': 'system', 'content': '你是助手'},
    {'role': 'user', 'content': '上一句'},
    {'role': 'assistant', 'content': '上一句的回答'},
    {'role': 'user', 'content': '有哪些部门？'},
]
_CLIENT = OpenAICompatClient(base_url='http://unused/v1', api_key='k', model='m')


def _ctx(max_rounds: int = 5) -> RunContext:
    return RunContext(user=SimpleNamespace(id=1), conversation_id=1, db=None, provider=None, max_tool_rounds=max_rounds)  # type: ignore[arg-type]


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    """把 dispatcher 换成记账的：调用参数里带 `confirm` 的走确认，其余成功"""
    calls: list[tuple[str, dict[str, Any]]] = []

    async def _dispatch(call: Any, _ctx: Any, *, pre_approved: bool = False) -> DispatchOutcome:  # ruff: ignore[unused-async]
        del pre_approved
        calls.append((call.name, call.arguments))
        if call.arguments.get('name') == 'confirm':
            return DispatchOutcome(
                kind='confirm_required', payload='待确认', summary='待确认', confirm_token='tok', preview='将新建'
            )
        return DispatchOutcome(
            kind='ok', payload='RESULT:技术部', summary='查到 1 个', perm='sys:dept:list', duration_ms=3
        )

    monkeypatch.setattr(tool_dispatcher, 'dispatch', _dispatch)
    return calls


def _returns(messages: list[ModelMessage]) -> list[str]:
    last = messages[-1]
    return [str(p.content) for p in last.parts if isinstance(p, ToolReturnPart)]


def _run(engine: Any, *, ctx: RunContext | None = None) -> list[Any]:
    async def _collect() -> list[Any]:
        return [e async for e in engine.run(_HISTORY, _TOOLS, ctx or _ctx())]

    return asyncio.run(_collect())


def _engine(stream: Any) -> PydanticAIEngine:
    return PydanticAIEngine(_CLIENT, model=FunctionModel(stream_function=stream))


def _types(events: list[Any]) -> list[str]:
    return [e.type for e in events if e.type != 'usage']


def _text(events: list[Any]) -> str:
    return ''.join(e.text for e in events if e.type == 'delta')


class TestStreaming:
    def test_first_text_chunk_is_not_dropped(self, dispatched: list[Any]) -> None:
        """首段文字在 PartStartEvent 里 —— 只取 delta 的话「你好」会变成「好」"""

        async def stream(_m: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[str]:  # ruff: ignore[unused-async]
            yield '你'
            yield '好'

        events = _run(_engine(stream))
        assert _text(events) == '你好'
        assert _types(events) == ['delta', 'delta', 'done']
        assert not dispatched

    def test_history_and_instructions_reach_the_model(self, dispatched: list[Any]) -> None:
        seen: dict[str, Any] = {}

        async def stream(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[str]:  # ruff: ignore[unused-async]
            seen['prompts'] = [
                p.content
                for m in messages
                if isinstance(m, ModelRequest)
                for p in m.parts
                if isinstance(p, UserPromptPart)
            ]
            seen['instructions'] = info.instructions
            seen['tools'] = [t.name for t in info.function_tools]
            yield 'ok'

        _run(_engine(stream))
        assert seen['prompts'] == ['上一句', '有哪些部门？']
        assert seen['instructions'] == '你是助手'
        assert seen['tools'] == ['dept_list']

    def test_history_must_end_with_user(self) -> None:
        with pytest.raises(ValueError, match='用户输入'):
            split_history([{'role': 'user', 'content': 'a'}, {'role': 'assistant', 'content': 'b'}])


class TestToolsGoThroughDispatcher:
    def test_tool_result_comes_from_dispatcher(self, dispatched: list[Any]) -> None:
        async def stream(messages: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[Any]:  # ruff: ignore[unused-async]
            if returns := _returns(messages):
                yield f'答：{returns[0]}'
            else:
                yield {0: DeltaToolCall(name='dept_list', json_args='{"name": "技术"}', tool_call_id='c1')}

        events = _run(_engine(stream))
        assert dispatched == [('dept_list', {'name': '技术'})]
        assert _types(events) == ['tool_call', 'tool_result', 'delta', 'done']
        result = next(e for e in events if e.type == 'tool_result')
        assert (result.call_id, result.ok, result.perm, result.duration_ms) == ('c1', True, 'sys:dept:list', 3)
        # 模型看到的结果就是 dispatcher 给的 payload，不是框架自己算的
        assert _text(events) == '答：RESULT:技术部'

    def test_confirm_required_stops_the_turn(self, dispatched: list[Any]) -> None:
        model_turns: list[int] = []

        async def stream(_m: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[Any]:  # ruff: ignore[unused-async]
            model_turns.append(1)
            yield {0: DeltaToolCall(name='dept_list', json_args='{"name": "confirm"}', tool_call_id='c1')}

        events = _run(_engine(stream))
        assert _types(events) == ['tool_call', 'confirm_required', 'done']
        confirm = next(e for e in events if e.type == 'confirm_required')
        assert (confirm.token, confirm.preview, confirm.arguments) == ('tok', '将新建', {'name': 'confirm'})
        assert len(model_turns) == 1, '待确认时又去问了模型 —— 它会对着一个还没发生的结果编下文'

    def test_bad_json_is_retried_not_fatal(self, dispatched: list[Any]) -> None:
        """`ExternalToolset` 原生重试是 0：一次坏 JSON 整轮报错。放宽后模型能改口"""
        attempts: list[int] = []

        async def stream(messages: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[Any]:  # ruff: ignore[unused-async]
            if _returns(messages):
                yield '好了'
                return
            attempts.append(1)
            args = '{"name": "技' if len(attempts) == 1 else '{"name": "技术"}'
            yield {0: DeltaToolCall(name='dept_list', json_args=args, tool_call_id=f'c{len(attempts)}')}

        events = _run(_engine(stream))
        assert 'error' not in _types(events), events
        assert len(attempts) == 2
        assert dispatched == [('dept_list', {'name': '技术'})], '坏参数不该到 dispatcher'

    def test_round_limit_is_enforced(self, dispatched: list[Any]) -> None:
        """`tool_calls_limit` 不计 external 调用 —— 用它的话这条会无限转下去"""

        async def stream(messages: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[Any]:  # ruff: ignore[unused-async]
            yield {0: DeltaToolCall(name='dept_list', json_args='{}', tool_call_id=f'c{len(messages)}')}

        events = _run(_engine(stream), ctx=_ctx(max_rounds=3))
        assert events[-1].type == 'error'
        assert events[-1].code == 'max_rounds'
        assert len(dispatched) == 3

    def test_model_error_is_a_visible_frame(self, dispatched: list[Any]) -> None:
        async def stream(_m: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[str]:  # ruff: ignore[unused-async]
            raise RuntimeError('网关 502')
            yield ''  # pragma: no cover

        events = _run(_engine(stream))
        assert events[-1].type == 'error'
        assert events[-1].code == 'llm_error'
        assert '502' in events[-1].message


class TestRegistry:
    def test_config_selects_engine(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(engine_registry.settings, 'AI_AGENT_ENGINE', 'pydantic_ai')
        assert isinstance(engine_registry.build_engine(_CLIENT), PydanticAIEngine)
        monkeypatch.setattr(engine_registry.settings, 'AI_AGENT_ENGINE', 'native')
        assert isinstance(engine_registry.build_engine(_CLIENT), NativeLoopEngine)


class _ScriptedClient(OpenAICompatClient):
    """给 native 引擎的假客户端：同一段脚本，按「上一条是不是工具结果」决定说什么"""

    def __init__(self) -> None:
        super().__init__(base_url='http://unused/v1', api_key='k', model='m')

    async def stream_chat(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]] | None = None, *, temperature: float = 0.3
    ) -> AsyncIterator[StreamDelta]:
        del tools, temperature
        if messages[-1]['role'] == 'tool':
            yield StreamDelta(text=f'答：{messages[-1]["content"]}')
            return
        name = 'confirm' if '确认' in messages[-1].get('content', '') else '技术'
        yield StreamDelta(
            tool_calls=[
                {'index': 0, 'id': 'c1', 'function': {'name': 'dept_list', 'arguments': json.dumps({'name': name})}}
            ]
        )


class TestParityWithNative:
    """同一段对话，两个引擎的事件序列必须一样 —— 前端只认事件，不认引擎"""

    @pytest.mark.parametrize('prompt', ['有哪些部门？', '新建一个，请确认'])
    def test_same_events(self, dispatched: list[Any], prompt: str) -> None:
        history = [*_HISTORY[:-1], {'role': 'user', 'content': prompt}]

        async def stream(messages: list[ModelMessage], _i: AgentInfo) -> AsyncIterator[Any]:  # ruff: ignore[unused-async]
            if returns := _returns(messages):
                yield f'答：{returns[0]}'
            else:
                name = 'confirm' if '确认' in prompt else '技术'
                yield {0: DeltaToolCall(name='dept_list', json_args=json.dumps({'name': name}), tool_call_id='c1')}

        async def _collect(engine: Any) -> list[Any]:
            return [e async for e in engine.run(history, _TOOLS, _ctx())]

        native = asyncio.run(_collect(NativeLoopEngine(_ScriptedClient())))
        pai = asyncio.run(_collect(_engine(stream)))

        def shape(events: list[Any]) -> list[tuple[Any, ...]]:
            return [
                (e.type, getattr(e, 'name', None), getattr(e, 'ok', None), getattr(e, 'token', None))
                for e in events
                if e.type != 'usage'
            ]

        assert shape(pai) == shape(native)
        assert _text(pai) == _text(native)
