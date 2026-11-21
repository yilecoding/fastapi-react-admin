"""#395 ④：模型密钥解不开时要给看得见的报错；同一会话的流锁不能被别人的流删掉。

- `AI_ENCRYPT_SECRET_KEY` 换过 / 多副本不一致 / 长度不对：`decrypt()` 抛裸 `ValueError`（实测换一把密钥解 300 次，
  298 次 `Invalid padding bytes`、2 次 `UnicodeDecodeError`），`stream()` 只接 `BaseExceptionError` ——
  200 头已经发出，生成器抛异常，前端收不到 `error` 帧，原因只在服务端日志里；「测试连接」是一个无说明的 500
- 流锁值恒为 `'1'`、300 秒过期、`finally` 无条件 `DELETE`：慢模型超过 5 分钟，同一会话能再进一条流，
  第一条结束时把第二条的锁删掉

数据库换成假的（同 `test_ai_turn_persistence.py`）；Redis 用真的（锁的语义就是 Redis 的语义）。
"""

import asyncio
import json
import os
import uuid

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.common.exception import errors
from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.plugin.ai.core.events import DeltaEvent, DoneEvent
from backend.plugin.ai.model import AiProvider
from backend.plugin.ai.service import chat_service as chat_module
from backend.plugin.ai.service import provider_service as provider_module
from backend.plugin.ai.service.chat_service import ChatService
from backend.plugin.ai.service.provider_service import ai_provider_service
from backend.tests.utils.data_change import engine
from backend.utils.encrypt import AESCipher

_USER = SimpleNamespace(id=1, is_superuser=True, is_staff=True, roles=[])
_RUN = uuid.uuid4().hex[:8]


def _provider(key: str) -> Any:
    return SimpleNamespace(
        api_key_cipher=AESCipher(key).encrypt('sk-real').hex(),
        base_url='http://127.0.0.1:9/v1',
        model='m',
        timeout=5,
        verify_ssl=True,
        use_proxy=False,
    )


# ---------- 解密 ----------


@pytest.mark.parametrize(
    'current',
    [
        os.urandom(32).hex(),  # 换了一把
        os.urandom(5).hex(),  # 长度不对
        'not-hex',
    ],
)
def test_build_client_raises_a_business_error_when_the_key_cannot_decrypt(
    monkeypatch: pytest.MonkeyPatch, current: str
) -> None:
    stored = _provider(os.urandom(32).hex())
    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', current)
    for _ in range(20):  # 换密钥解密大多是 padding 错，偶尔是 UnicodeDecodeError：多试几次两种都碰到
        with pytest.raises(errors.ServerError) as info:
            ai_provider_service.build_client(stored)
        assert 'AI_ENCRYPT_SECRET_KEY' in info.value.msg, '要说清楚是哪把密钥的问题'
        stored = _provider(os.urandom(32).hex())


class _FakeSession:
    async def commit(self) -> None:
        return

    async def rollback(self) -> None:
        return


@pytest.fixture
def chat(monkeypatch: pytest.MonkeyPatch) -> Iterator[dict[str, Any]]:
    saved: list[dict[str, Any]] = []
    state: dict[str, Any] = {'saved': saved, 'events': [], 'provider': None}

    @asynccontextmanager
    async def _session() -> AsyncIterator[_FakeSession]:
        yield _FakeSession()

    _session.begin = _session

    async def _create(_db: Any, **kw: Any) -> Any:  # ruff: ignore[unused-async]
        saved.append(kw)
        return SimpleNamespace(**kw)

    async def _owned(**_k: Any) -> Any:  # ruff: ignore[unused-async]
        return SimpleNamespace(provider_id=None)

    async def _resolve(*_a: Any) -> Any:  # ruff: ignore[unused-async]
        return state['provider']

    class _Engine:
        async def run(self, *_a: Any) -> AsyncIterator[Any]:
            for ev in state['events']:
                if callable(ev):
                    await ev()
                    continue
                yield ev

    async def _no_off() -> frozenset[str]:  # ruff: ignore[unused-async]
        return frozenset()

    async def _hist(*_a: Any) -> list[dict[str, Any]]:  # ruff: ignore[unused-async]
        return [{'role': 'user', 'content': 'x'}]

    monkeypatch.setattr(chat_module, 'async_db_session', _session)
    monkeypatch.setattr(chat_module.ai_message_dao, 'create', _create)
    monkeypatch.setattr(chat_module.conversation_service, 'get_owned', _owned)
    monkeypatch.setattr(chat_module, '_resolve_provider', _resolve)
    monkeypatch.setattr(chat_module, 'build_engine', lambda _c: _Engine())
    monkeypatch.setattr(chat_module.tool_dispatcher, 'visible_schemas', lambda *_a: [])
    monkeypatch.setattr(chat_module.tool_dispatcher, 'off_plugins', _no_off)
    monkeypatch.setattr(chat_module, '_build_history', _hist)
    return state


def _run_stream(conversation_id: int, *, during: Any = None) -> list[dict[str, Any]]:
    """在一个新事件循环里跑完一条流；Redis 用这个循环自己的连接"""

    async def go() -> list[dict[str, Any]]:
        redis = RedisCli()
        chat_module.redis_client = redis  # monkeypatch 在 fixture 外恢复不了这个：手动收尾
        try:
            frames = [
                json.loads(f[5:])
                async for f in ChatService.stream(user=_USER, conversation_id=conversation_id, content='hi')
            ]
            if during is not None:
                frames.append({'after': await during(redis)})
            return frames
        finally:
            await redis.aclose()

    original = chat_module.redis_client
    try:
        return asyncio.run(go())
    finally:
        chat_module.redis_client = original


def test_undecryptable_key_ends_the_stream_with_a_visible_error(
    chat: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    chat['provider'] = _provider(os.urandom(32).hex())
    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', os.urandom(32).hex())

    frames = _run_stream(int(_RUN, 16))
    assert frames, '一帧都没有 = 前端只能看到「连接中途断开」'
    assert frames[-1]['type'] == 'error'
    assert 'AI_ENCRYPT_SECRET_KEY' in frames[-1]['message']

    roles = [m['role'] for m in chat['saved']]
    assert roles == ['user', 'assistant'], '用户那句话和这条报错都要落库：流一结束前端重拉历史，不落库就被冲掉'
    [item] = json.loads(chat['saved'][1]['tool_calls'])
    assert item['kind'] == 'error'
    assert item['message'] == frames[-1]['message']


def test_unexpected_setup_failure_is_still_a_visible_error(
    chat: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """兜底：准备阶段抛的不是业务异常也不能断流"""
    chat['provider'] = SimpleNamespace()

    def boom(_p: Any) -> Any:
        raise RuntimeError('意料之外')

    monkeypatch.setattr(chat_module.ai_provider_service, 'build_client', boom)
    frames = _run_stream(int(_RUN, 16) + 1)
    assert frames[-1]['type'] == 'error'
    assert '意料之外' not in frames[-1]['message'], '原文进日志，不糊给用户'


# ---------- 测试连接 ----------

PROVIDERS = '/ai/providers'


@pytest.fixture
def _purge_providers() -> Iterator[None]:
    yield
    with engine().begin() as conn:
        table = AiProvider.__table__
        conn.execute(sa.delete(table).where(table.c.name.like(f'pytest-key-{_RUN}%')))


@pytest.mark.usefixtures('_purge_providers')
def test_test_connection_reports_the_key_problem_instead_of_a_bare_500(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    name = f'pytest-key-{_RUN}'
    body = {
        'name': name,
        'provider_type': 'custom',
        'base_url': 'http://127.0.0.1:9/v1',
        'model': 'm',
        'api_key': 'sk-x',
    }
    assert client.post(PROVIDERS, headers=token_headers, json=body).json()['code'] == 200
    with engine().connect() as conn:
        table = AiProvider.__table__
        pk = conn.execute(sa.select(table.c.id).where(table.c.name == name)).scalar_one()

    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', os.urandom(32).hex())  # 换了密钥
    response = client.post(f'{PROVIDERS}/{pk}/test', headers=token_headers)
    assert response.status_code == 200, response.text
    data = response.json()['data']
    assert data['ok'] is False
    assert 'AI_ENCRYPT_SECRET_KEY' in data['message']


# ---------- 流锁 ----------


def test_a_finished_stream_does_not_release_someone_elses_lock(
    chat: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, 'AI_ENCRYPT_SECRET_KEY', os.urandom(32).hex())
    monkeypatch.setattr(chat_module.ai_provider_service, 'build_client', lambda _p: None)
    chat['provider'] = SimpleNamespace()
    conversation_id = int(_RUN, 16) + 2
    key = f'fba:ai:stream:{conversation_id}'

    async def lock_expires_and_another_stream_takes_it() -> None:
        redis = chat_module.redis_client
        await redis.delete(key)
        assert await redis.set(key, 'second-stream', ex=60, nx=True)

    chat['events'] = [DeltaEvent(text='慢'), lock_expires_and_another_stream_takes_it, DoneEvent()]

    async def read(redis: RedisCli) -> str | None:
        value = await redis.get(key)
        await redis.delete(key)
        return value

    frames = _run_stream(conversation_id, during=read)
    assert frames[-1] == {'after': 'second-stream'}, '第一条流收尾时删掉了第二条的锁'


def test_the_lock_is_renewed_while_the_stream_runs(chat: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chat_module.ai_provider_service, 'build_client', lambda _p: None)
    monkeypatch.setattr(chat_module, 'STREAM_LOCK_TTL', 2)
    monkeypatch.setattr(chat_module, 'STREAM_LOCK_RENEW_EVERY', 0.3)
    chat['provider'] = SimpleNamespace()
    conversation_id = int(_RUN, 16) + 3
    key = f'fba:ai:stream:{conversation_id}'
    seen: list[bool] = []

    async def slow_model() -> None:
        await asyncio.sleep(3)  # 比锁的 TTL 长
        seen.append(bool(await chat_module.redis_client.exists(key)))

    chat['events'] = [slow_model, DoneEvent()]
    _run_stream(conversation_id)
    assert seen == [True], '模型还没回完锁就过期了：同一会话能再进一条流'
    assert provider_module  # 保持导入：provider_service 是被测对象之一
