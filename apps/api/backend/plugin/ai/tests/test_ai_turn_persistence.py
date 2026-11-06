"""一轮对话「界面上出现过的东西」都要落库 —— 2026-11-06 本地真跑（假模型）查出来的三处。

- 网页上 AI 的写操作**一个都确认不了**（确认卡片一闪就没）：模型调写工具时不说话，
  `if text:` 才落库；流一结束前端重拉历史，卡片被冲掉
- 「达到 5 轮上限」的报错刷新后变成一句没有下文的提问：同上，只有报错的一轮不落库
- 流到第 9 段时刷新，回来只剩用户那句话：断开时抛的是 `CancelledError`（不是 `Exception`），
  写在 try 后面的落库不跑

外加确认结果写回会话（刷新后卡片显示「已执行」、下一轮模型知道这件事办了），
以及工具参数错误不再把 Python / pydantic 的原文糊给用户。

数据库和 Redis 都换成假的：这里测的是「编排层把什么交给了落库」，不是 SQL。
"""

import asyncio
import json

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from pydantic import BaseModel, Field, ValidationError

from backend.plugin.ai.core.dispatcher import _argument_problem, _error_text
from backend.plugin.ai.core.events import ConfirmRequiredEvent, DeltaEvent, DoneEvent, ErrorEvent, ToolResultEvent
from backend.plugin.ai.schema.conversation import ChatParam
from backend.plugin.ai.service import chat_service as chat_module
from backend.plugin.ai.service.chat_service import ChatService, _build_history, _settle_confirm

_USER = SimpleNamespace(id=1, is_superuser=True, is_staff=True, roles=[])


class _FakeRedis:
    async def set(self, *_a: Any, **_k: Any) -> bool:
        return True

    async def delete(self, *_a: Any) -> int:
        return 1


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1

    async def rollback(self) -> None:
        return


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:  # ruff: ignore[complex-structure]
    saved: list[dict[str, Any]] = []
    rows: list[Any] = []
    state: dict[str, Any] = {'events': [], 'saved': saved, 'rows': rows}

    @asynccontextmanager
    async def _session() -> AsyncIterator[_FakeSession]:
        yield _FakeSession()

    _session.begin = _session  # `async_db_session.begin()` 同形状

    async def _create(_db: Any, **kw: Any) -> Any:  # ruff: ignore[unused-async]
        saved.append(kw)
        return SimpleNamespace(**kw)

    async def _history(_db: Any, _cid: int, limit: int = 40) -> list[Any]:  # ruff: ignore[unused-async]
        return rows[-limit:]

    class _Engine:
        async def run(self, *_a: Any) -> AsyncIterator[Any]:
            for ev in state['events']:
                if ev == 'hang':
                    await asyncio.sleep(30)
                yield ev

    async def _owned(**_k: Any) -> Any:  # ruff: ignore[unused-async]
        return SimpleNamespace(provider_id=None)

    async def _provider(*_a: Any) -> Any:  # ruff: ignore[unused-async]
        return SimpleNamespace()

    async def _no_off() -> frozenset[str]:  # ruff: ignore[unused-async]
        return frozenset()

    async def _hist(*_a: Any) -> list[dict[str, Any]]:  # ruff: ignore[unused-async]
        return [{'role': 'user', 'content': 'x'}]

    monkeypatch.setattr(chat_module, 'redis_client', _FakeRedis())
    monkeypatch.setattr(chat_module, 'async_db_session', _session)
    monkeypatch.setattr(chat_module.ai_message_dao, 'create', _create)
    monkeypatch.setattr(chat_module.ai_message_dao, 'get_history', _history)
    monkeypatch.setattr(chat_module.conversation_service, 'get_owned', _owned)
    monkeypatch.setattr(chat_module, '_resolve_provider', _provider)
    monkeypatch.setattr(chat_module.ai_provider_service, 'build_client', lambda _p: None)
    monkeypatch.setattr(chat_module, 'build_engine', lambda _c: _Engine())
    monkeypatch.setattr(chat_module.tool_dispatcher, 'visible_schemas', lambda *_a: [])
    monkeypatch.setattr(chat_module.tool_dispatcher, 'off_plugins', _no_off)
    monkeypatch.setattr(chat_module, '_build_history', _hist)
    return state


async def _drain(gen: AsyncIterator[str]) -> list[dict[str, Any]]:
    return [json.loads(frame[5:]) async for frame in gen]


def _assistant(saved: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [m for m in saved if m['role'] == 'assistant']


def test_confirm_card_is_persisted_even_without_text(harness: dict[str, Any]) -> None:
    """🔴 修复前：没有正文 → 这一轮不落库 → 前端重拉历史后卡片消失，写操作永远确认不了"""
    harness['events'] = [
        ConfirmRequiredEvent(token='cf_1', name='dept_create', preview='将新建部门「A」'),
        DoneEvent(),
    ]
    asyncio.run(_drain(ChatService.stream(user=_USER, conversation_id=1, content='建个部门')))

    [msg] = _assistant(harness['saved'])
    assert not msg['content']
    [item] = json.loads(msg['tool_calls'])
    assert item == {
        'kind': 'confirm',
        'token': 'cf_1',
        'name': 'dept_create',
        'preview': '将新建部门「A」',
        'outcome': None,
    }


def test_error_only_turn_keeps_traces_and_error(harness: dict[str, Any]) -> None:
    """达到工具轮数上限：没有正文，但轨迹和报错都是用户看见过的"""
    harness['events'] = [
        ToolResultEvent(call_id='c', name='system_whoami', ok=True, summary='ok', perm=None, duration_ms=1),
        ErrorEvent(message='已达到单轮最多 5 次工具调用的上限', code='max_rounds'),
    ]
    asyncio.run(_drain(ChatService.stream(user=_USER, conversation_id=1, content='loop')))

    [msg] = _assistant(harness['saved'])
    items = json.loads(msg['tool_calls'])
    assert items[0]['name'] == 'system_whoami'
    assert items[1] == {'kind': 'error', 'message': '已达到单轮最多 5 次工具调用的上限', 'code': 'max_rounds'}


def test_partial_answer_survives_client_disconnect(harness: dict[str, Any]) -> None:
    """🔴 修复前：客户端断开 = 任务被取消（`CancelledError` 不是 `Exception`），落库那段不跑"""
    harness['events'] = [DeltaEvent(text='第0段。'), DeltaEvent(text='第1段。'), 'hang']

    async def scenario() -> None:
        two_frames = asyncio.Event()

        async def consume() -> None:
            seen = 0
            async for _frame in ChatService.stream(user=_USER, conversation_id=1, content='SLOW'):
                seen += 1
                if seen == 2:
                    two_frames.set()

        task = asyncio.create_task(consume())
        await asyncio.wait_for(two_frames.wait(), timeout=10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    [msg] = _assistant(harness['saved'])
    assert msg['content'] == '第0段。第1段。'


def test_confirm_outcome_is_written_back_and_fed_to_the_model(harness: dict[str, Any]) -> None:
    item = {'kind': 'confirm', 'token': 'cf_9', 'name': 'dept_create', 'preview': '将新建部门「A」', 'outcome': None}
    row = SimpleNamespace(role='assistant', content='', tool_calls=json.dumps([item], ensure_ascii=False))
    harness['rows'].extend([SimpleNamespace(role='user', content='建个部门', tool_calls=None), row])

    asyncio.run(_settle_confirm(1, 'cf_9', 'done', None))
    assert json.loads(row.tool_calls)[0]['outcome'] == 'done'

    # 下一轮的历史：这条助手消息原来正文为空、会被整条丢掉，模型不知道部门已经建了
    history = asyncio.run(_build_history(None, 1))
    assert history[-1]['role'] == 'assistant'
    assert '将新建部门「A」' in history[-1]['content']
    assert '执行成功' in history[-1]['content']


def test_pending_confirm_is_visible_to_the_model_as_not_yet_done(harness: dict[str, Any]) -> None:
    item = {'kind': 'confirm', 'token': 'cf_8', 'name': 'role_create', 'preview': '将新建角色「B」', 'outcome': None}
    harness['rows'].append(SimpleNamespace(role='assistant', content='好的', tool_calls=json.dumps([item])))
    history = asyncio.run(_build_history(None, 1))
    assert '尚未执行' in history[-1]['content']


class TestArgumentErrorsAreReadable:
    """修复前回给用户的原文：`_preview_create() missing 2 required positional arguments: 'name' and 'code'`、
    `invalid literal for int() with base 10: 'abc'`、整段带链接的 pydantic 英文"""

    def test_missing_and_unknown_arguments(self) -> None:
        spec = SimpleNamespace(
            parameters={'properties': {'name': {}, 'code': {}, 'parent_id': {}}, 'required': ['name', 'code']}
        )
        assert _argument_problem(spec, {'name': 'A', 'code': 'B'}) is None
        problem = _argument_problem(spec, {'nmae': 'A'})
        assert '缺少必填参数 name、code' in problem
        assert '没有这些参数 nmae' in problem

    def test_validation_error_is_localized_without_link(self) -> None:
        class P(BaseModel):
            code: str = Field(pattern=r'^[A-Z][A-Z0-9_]*$')

        with pytest.raises(ValidationError) as exc:
            P(code='abc')
        text = _error_text(exc.value)
        assert text.startswith('code ')
        assert 'errors.pydantic.dev' not in text
        assert 'validation error' not in text

    def test_bad_int_id(self) -> None:
        try:
            int('abc')
        except ValueError as e:
            assert 'ID 格式不对' in _error_text(e)


def test_whitespace_only_message_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ChatParam(conversation_id='1', content='   \n ')
    assert ChatParam(conversation_id='1', content='  hi ').content == 'hi'


def test_history_api_replays_turns_without_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """🔴 落库修好之后实测才暴露的第二半：读历史的接口用 `and m.content` 把没有正文的消息滤掉了，
    卡片存进去了也回不来 —— 单测只测了「交给落库的是什么」，没测「读出来的是什么」"""
    from backend.plugin.ai.service import conversation_service as conv_module

    card = json.dumps([{'kind': 'confirm', 'token': 'cf_x', 'name': 'n', 'preview': 'p', 'outcome': None}])
    rows = [
        SimpleNamespace(role='user', content='建个部门', tool_calls=None),
        SimpleNamespace(role='assistant', content='', tool_calls=card),
        SimpleNamespace(role='assistant', content='', tool_calls=None),
        SimpleNamespace(role='tool', content='{}', tool_calls=None),
    ]

    async def _owned(**_k: Any) -> Any:  # ruff: ignore[unused-async]
        return SimpleNamespace()

    async def _history(*_a: Any, **_k: Any) -> list[Any]:  # ruff: ignore[unused-async]
        return rows

    monkeypatch.setattr(conv_module.ConversationService, 'get_owned', staticmethod(_owned))
    monkeypatch.setattr(conv_module.ai_message_dao, 'get_history', _history)
    got = asyncio.run(conv_module.conversation_service.get_messages(db=None, pk=1, user_id=1))
    assert [(m.role, m.tool_calls is not None) for m in got] == [('user', False), ('assistant', True)]
