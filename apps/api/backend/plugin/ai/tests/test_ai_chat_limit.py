"""网页对话按人限流（`AI_CHAT_RATE_PER_MINUTE`）。

🔴 原来只要有 `ai:chat:use` 就能无限循环地发，每一句都是一次或几次计费的模型请求 —— 一个循环脚本就能把网关额度用光、
挤掉真在用的人。超了要在开始流之前回 429：流开始之后状态码改不了。

不连模型：`chat_service.stream` 换成一个只回 `done` 的生成器，这里验的是路由前面那道闸。
"""

import asyncio

from collections.abc import AsyncIterator
from typing import Any

import pytest

from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.plugin.ai.service.chat_service import chat_service


def _clear_limiter_keys() -> None:
    """计数窗口在 Redis 里活一分钟：上一轮的计数会漏进这一轮"""

    async def go() -> None:
        redis = RedisCli()
        try:
            async for key in redis.scan_iter(f'{settings.REQUEST_LIMITER_REDIS_PREFIX}*'):
                await redis.delete(key)
        finally:
            await redis.aclose()

    asyncio.run(go())


def test_chat_is_rate_limited_per_person(
    client: TestClient, token_headers: dict[str, str], rate_limiter: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_stream(**_: Any) -> AsyncIterator[str]:  # ruff: ignore[unused-async] —— 顶掉的原函数是 async 生成器
        yield 'data: {"type": "done"}\n\n'

    monkeypatch.setattr(chat_service, 'stream', fake_stream)
    monkeypatch.setattr(settings, 'AI_CHAT_RATE_PER_MINUTE', 3)
    _clear_limiter_keys()
    try:
        body = {'conversation_id': '1', 'content': '你好'}
        # 带上前端的 Origin：开发期 / 桌面端前后端跨源，浏览器只让 JS 读 `Access-Control-Expose-Headers` 里列了的头
        headers = {**token_headers, 'Origin': 'http://localhost:8888'}
        responses = [client.post('/ai/chat/stream', headers=headers, json=body) for _ in range(4)]
    finally:
        _clear_limiter_keys()
    assert [r.status_code for r in responses] == [200, 200, 200, 429]
    # 前端按它说「请 N 秒后再发」：不暴露的话跨源读到 null，只能说一个猜的秒数
    assert responses[-1].headers.get('Retry-After'), responses[-1].headers
    assert 'retry-after' in responses[-1].headers.get('access-control-expose-headers', '').lower()
