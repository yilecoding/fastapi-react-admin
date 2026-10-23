"""在对话里审批接真模型跑（#111 第 4 条的验收）。

没配 `AI_TEST_BASE_URL` / `AI_TEST_API_KEY` / `AI_TEST_MODEL` 就整个跳过。

`test_ai_workflow_tools.py` 直接调 dispatcher，验的是工具和闸门；这里验假模型替不了的那一半：
真模型读了工具描述之后，会不会**先查待办拿到真 ID**再提议同意、会不会在用户没给理由时**自己拟一段驳回意见**。
后者靠的只是工具描述里那一句话，描述改坏了只有这里看得出来。

断言只卡「停在确认卡片上 / 没有替人拟意见」，不卡措辞；加 `-s` 看模型实际说了什么。
"""

import asyncio
import os
import uuid

from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import RedisCli
from backend.plugin.ai.core import dispatcher as dispatcher_module
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.events import ConfirmRequiredEvent, DeltaEvent, ToolCallEvent
from backend.plugin.ai.core.ports import RunContext
from backend.plugin.ai.engines.native import NativeLoopEngine
from backend.plugin.ai.llm.client import OpenAICompatClient
from backend.plugin.ai.service.chat_service import _SYSTEM_PROMPT
from backend.plugin.workflow.tests.test_ai_workflow_tools import (  # ruff: ignore[unused-import] —— 后两个是 autouse fixture
    _person,
    _setup,
    _start,
    _tools,
)
from backend.plugin.workflow.tests.test_ops import _detail
from backend.plugin.workflow.tests.test_timeouts import _no_push  # ruff: ignore[unused-import] —— autouse fixture

_BASE_URL = os.environ.get('AI_TEST_BASE_URL', '').strip()
_API_KEY = os.environ.get('AI_TEST_API_KEY', '').strip()
_MODEL = os.environ.get('AI_TEST_MODEL', '').strip()

pytestmark = pytest.mark.skipif(
    not (_BASE_URL and _API_KEY and _MODEL),
    reason='没配 AI_TEST_BASE_URL / AI_TEST_API_KEY / AI_TEST_MODEL，不跑真模型',
)


def _chat(monkeypatch: pytest.MonkeyPatch, user: Any, question: str) -> list[Any]:
    """和网页对话同一份系统提示词 + 同一份可见工具，跑一轮，收集事件"""

    async def main() -> list[Any]:
        redis = RedisCli()
        monkeypatch.setattr(dispatcher_module, 'redis_client', redis)
        engine = create_database_async_engine(get_database_url(unittest=True))
        client = OpenAICompatClient(
            base_url=_BASE_URL, api_key=_API_KEY, model=_MODEL, timeout=120, verify_ssl=False, use_proxy=False
        )
        try:
            async with create_database_async_session(engine)() as db:
                # user_said 同 chat_service：用户在这段对话里说过的话
                ctx = RunContext(
                    user=user, conversation_id=uuid.uuid4().int % 10**15, db=db, provider=None, user_said=[question]
                )
                history = [{'role': 'system', 'content': _SYSTEM_PROMPT}, {'role': 'user', 'content': question}]
                events = [
                    e async for e in NativeLoopEngine(client).run(history, tool_dispatcher.visible_schemas(user), ctx)
                ]
                await db.rollback()
                return events
        finally:
            await engine.dispose()
            await redis.aclose()

    events = asyncio.run(main())
    calls = [(e.name, e.arguments) for e in events if isinstance(e, ToolCallEvent)]
    text = ''.join(e.text for e in events if isinstance(e, DeltaEvent))
    print(f'\n[{_MODEL}] {question}\n  调用：{calls}\n  回答：{text[:300]}')
    return events


def test_approve_by_title_looks_up_the_real_id_and_stops_at_the_card(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup(client, token_headers, uid, 'PYTEST_AIWF_REAL_OK')
    pk = _start(client, login, 'PYTEST_AIWF_REAL_OK')
    events = _chat(
        monkeypatch, _person(uid('zhaolei'), '赵磊'), '看看我有哪些待办，把孙强那张 PYTEST_AIWF_REAL_OK 同意了'
    )

    cards = [e for e in events if isinstance(e, ConfirmRequiredEvent)]
    assert cards and cards[0].name == 'wf_approve', f'应停在「同意」的确认卡片上：{events}'
    assert cards[0].arguments['instance_id'] == pk, '模型要用查到的真 ID，不能编'
    assert _detail(client, token_headers, pk)['instance']['status'] == 'running', '确认之前什么都不该发生'


def test_reject_without_a_reason_does_not_get_one_made_up(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    """用户只说「驳回」不给理由：不能出现一张带着模型自拟意见的驳回卡片（应该回头问用户）"""
    _setup(client, token_headers, uid, 'PYTEST_AIWF_REAL_NO_REASON')
    _start(client, login, 'PYTEST_AIWF_REAL_NO_REASON')
    events = _chat(monkeypatch, _person(uid('zhaolei'), '赵磊'), '把孙强那张 PYTEST_AIWF_REAL_NO_REASON 驳回')
    assert not [e for e in events if isinstance(e, ConfirmRequiredEvent) and e.name == 'wf_reject'], events


def test_reject_with_a_reason_carries_the_users_words(
    client: TestClient, token_headers: dict[str, str], login: Any, uid: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    _setup(client, token_headers, uid, 'PYTEST_AIWF_REAL_REASON')
    _start(client, login, 'PYTEST_AIWF_REAL_REASON')
    events = _chat(
        monkeypatch,
        _person(uid('zhaolei'), '赵磊'),
        '把孙强那张 PYTEST_AIWF_REAL_REASON 驳回，理由：客户名称没写',
    )
    cards = [e for e in events if isinstance(e, ConfirmRequiredEvent)]
    assert cards and cards[0].name == 'wf_reject', events
    assert '客户名称没写' in cards[0].preview, '确认卡片上要原样显示用户给的理由'
