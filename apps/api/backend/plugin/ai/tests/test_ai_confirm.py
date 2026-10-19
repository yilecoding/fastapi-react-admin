"""二次确认令牌的守卫测试（真实 Redis）。

`/ai/chat/tools/confirm` 是变更类工具**唯一**的执行入口，令牌是它的全部凭据。
这里测的两件事，失败时都没有任何现象 —— 接口照样返回 tool_result / 错误帧：

- **一次性必须是原子的**：两个并发确认（双击、网络重试、两个标签页）都读到令牌，
  同一个变更就执行两次。对「新建部门」是多一条重复数据，对「删除」是第二次报错，
  对「给角色加权限」这类非幂等操作就是静默的重复写
- **先验归属再消费**：别人拿到令牌（日志、截图、转发）时，最多是「执行不了」，
  不能顺手把原用户那次确认作废 —— 否则原用户点确认只会看到「已过期」，查不出原因

⚠️ 用真实 Redis 而不是 mock：竞态就发生在「读」和「删」两次网络往返之间，
mock 掉 Redis 就把要测的那段窗口一起 mock 没了。
"""

import asyncio
import json
import uuid

from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.plugin.ai.core.dispatcher import DispatchOutcome
from backend.plugin.ai.core.registry import _REGISTRY, ai_tool
from backend.plugin.ai.service import chat_service as chat_module
from backend.plugin.ai.service.chat_service import ChatService

_TOOL = '_probe_mutate'


def _user(uid: int) -> Any:
    return SimpleNamespace(id=uid, is_superuser=True, is_staff=True, roles=[])


@asynccontextmanager
async def _fake_session() -> AsyncIterator[Any]:
    """确认路径只用会话做 commit；这里测的是令牌，不是落库"""

    async def _commit() -> None:  # ruff: ignore[unused-async]
        return

    yield SimpleNamespace(commit=_commit)


@pytest.fixture
def probe_tool() -> Iterator[None]:
    async def _preview() -> str:  # ruff: ignore[unused-async]
        return '探针预演'

    @ai_tool(name=_TOOL, description='探针', domain='system', perm=None, mutating=True, preview=_preview)
    async def _probe() -> dict[str, Any]:  # ruff: ignore[unused-async]
        return {'ok': True}

    try:
        yield
    finally:
        _REGISTRY.pop(_TOOL, None)


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch, probe_tool: None) -> dict[str, Any]:
    """把 dispatch 换成计数器，会话换成假的；Redis 留真的（在各自的事件循环里换上）"""
    executed: list[str] = []

    async def _dispatch(call: Any, _ctx: Any, *, pre_approved: bool = False) -> DispatchOutcome:
        assert pre_approved, '确认路径必须以 pre_approved=True 执行'
        executed.append(call.call_id)
        await asyncio.sleep(0)  # 真实 dispatch 会让出事件循环（查库、写审计）
        return DispatchOutcome(kind='ok', payload='{}', summary='ok', perm=None, duration_ms=0)

    monkeypatch.setattr(chat_module.tool_dispatcher, 'dispatch', _dispatch)
    monkeypatch.setattr(chat_module, 'async_db_session', _fake_session)
    return {'executed': executed, 'monkeypatch': monkeypatch}


def _codes(frames: list[str]) -> list[str]:
    out = []
    for frame in frames:
        body = json.loads(frame.removeprefix('data: ').strip())
        out.append(body.get('code') or body['type'])
    return out


async def _consume(user: Any, token: str) -> list[str]:
    return [f async for f in ChatService.confirm_tool(user=user, token=token)]


def _run(harness: dict[str, Any], scenario: Any) -> Any:
    """在一个新事件循环里换上**新开的** Redis 连接再跑场景。

    ⚠️ 不能用模块级的 `redis_client` —— 它绑在 TestClient 的事件循环上
    （同 `test_auth.py: _clear_login_counters` 踩过的坑）。
    """

    async def _main() -> Any:
        client = RedisCli()
        # 🔴 先把连接池预热。冷池里第一个请求复用已有连接、其余的都在建新连接
        # （connect + AUTH），慢出一大截 —— 第一个「读 + 删」早就做完了，
        # 竞态测试会**假绿**。实测：冷池 5 个并发只有 1 个读到令牌，热池 5 个全读到。
        # 生产环境的连接池是热的，所以热池才是要测的那个现实
        await asyncio.gather(*(client.ping() for _ in range(8)))
        harness['monkeypatch'].setattr(chat_module, 'redis_client', client)
        try:
            return await scenario(client)
        finally:
            await client.aclose()

    return asyncio.run(_main())


async def _stage(client: RedisCli, *, owner: int) -> str:
    token = uuid.uuid4().hex
    await client.set(
        f'{settings.AI_CONFIRM_REDIS_PREFIX}:{token}',
        json.dumps({'tool': _TOOL, 'arguments': {}, 'user_id': str(owner), 'conversation_id': '1'}),
        ex=60,
    )
    return token


class TestConfirmToken:
    def test_concurrent_confirms_execute_once(self, harness: dict[str, Any]) -> None:
        async def scenario(client: RedisCli) -> list[list[str]]:
            token = await _stage(client, owner=1)
            return list(await asyncio.gather(*(_consume(_user(1), token) for _ in range(5))))

        results = _run(harness, scenario)
        assert len(harness['executed']) == 1, (
            f'同一个令牌被并发确认执行了 {len(harness["executed"])} 次 —— 「先读再删」不是原子的'
        )
        outcomes = sorted(_codes(r)[0] for r in results)
        assert outcomes == ['confirm_expired'] * 4 + ['tool_result'], outcomes

    def test_foreign_user_cannot_burn_the_token(self, harness: dict[str, Any]) -> None:
        async def scenario(client: RedisCli) -> tuple[list[str], list[str]]:
            token = await _stage(client, owner=1)
            stranger = await _consume(_user(2), token)
            owner = await _consume(_user(1), token)
            return stranger, owner

        stranger, owner = _run(harness, scenario)
        assert _codes(stranger) == ['confirm_mismatch'], stranger
        assert _codes(owner) == ['tool_result', 'done'], (
            f'别人拿令牌试了一次之后，本人的确认变成了 {_codes(owner)} —— 令牌在验归属之前就被删了'
        )
        assert len(harness['executed']) == 1

    def test_token_is_single_use(self, harness: dict[str, Any]) -> None:
        async def scenario(client: RedisCli) -> tuple[list[str], list[str]]:
            token = await _stage(client, owner=1)
            return await _consume(_user(1), token), await _consume(_user(1), token)

        first, second = _run(harness, scenario)
        assert _codes(first) == ['tool_result', 'done']
        assert _codes(second) == ['confirm_expired']
        assert len(harness['executed']) == 1
