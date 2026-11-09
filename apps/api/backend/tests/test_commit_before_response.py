"""🔴 写接口的事务要在**响应发出之前**提交。

FastAPI 0.141 的 `yield` 依赖默认（`scope='request'`）在 `await response(...)` **之后**才收尾，
而 `get_db_transaction` 的提交就在收尾里。于是：

- 客户端拿到 200 时事务可能还没提交 —— 「建用户 → 马上用它登录」实测 30 次失败 6 次（「用户名或密码有误」）
- 提交时出的错（唯一约束、审计写入…）发生在 200 已经发出之后：接口说成功，数据其实回滚了

`CurrentSessionTransaction` 改成 `Depends(get_db_transaction, scope='function')`：提交在路由函数收尾时做，
响应等它。这里用 ASGI 层的 `send` 记「响应开始」的时刻，和这个请求自己那次提交比先后。
"""

from collections.abc import Iterator
from contextvars import ContextVar
from typing import Any

import httpx
import pytest

from sqlalchemy import delete, event
from sqlalchemy.orm import Session
from starlette.testclient import TestClient

from backend.app.admin.model import UserPreference
from backend.tests.utils.db import async_test_db_session

KEY = 'pytest.commitorder'

#: 只认这个请求自己的会话：后台的操作日志消费者也在提交，它没有这个标记
_mine: ContextVar[bool] = ContextVar('commit_order_probe', default=False)


async def _purge() -> None:
    async with async_test_db_session.begin() as db:
        await db.execute(delete(UserPreference).where(UserPreference.key == KEY))


@pytest.fixture
def order(client: TestClient) -> Iterator[list[str]]:
    events: list[str] = []

    def on_commit(_session: Session) -> None:
        if _mine.get():
            events.append('commit')

    client.portal.call(_purge)
    event.listen(Session, 'after_commit', on_commit)
    yield events
    event.remove(Session, 'after_commit', on_commit)
    client.portal.call(_purge)


def _put(client: TestClient, headers: dict[str, str], events: list[str]) -> httpx.Response:
    app = client.app

    async def spy_app(scope: Any, receive: Any, send: Any) -> None:
        async def spy_send(message: Any) -> None:
            if message['type'] == 'http.response.start':
                events.append('response')
            await send(message)

        await app(scope, receive, spy_send)

    async def call() -> httpx.Response:
        token = _mine.set(True)
        try:
            # 不让应用的异常冒到这里：要看的正是「客户端收到了什么」
            transport = httpx.ASGITransport(app=spy_app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url=str(client.base_url)) as c:
                return await c.put(f'/sys/users/me/preferences/{KEY}', headers=headers, json={'value': {'n': 1}})
        finally:
            _mine.reset(token)

    return client.portal.call(call)


def test_the_transaction_commits_before_the_response_is_sent(
    client: TestClient, token_headers: dict[str, str], order: list[str]
) -> None:
    res = _put(client, token_headers, order)
    assert res.json()['code'] == 200, res.text
    assert 'commit' in order, order
    assert order.index('commit') < order.index('response'), f'响应先于提交发出：{order}'


def test_a_failed_commit_is_not_reported_as_success(
    client: TestClient, token_headers: dict[str, str], order: list[str]
) -> None:
    """提交时出错：客户端要收到失败，不是一个「成功」—— 而数据其实没存上"""

    def boom(_session: Session) -> None:
        if _mine.get():
            raise RuntimeError('提交时出错（测试注入）')

    event.listen(Session, 'before_commit', boom)
    try:
        res = _put(client, token_headers, order)
    finally:
        event.remove(Session, 'before_commit', boom)
    # 修之前：200「请求成功」，而这次写入已经回滚；修之后：500 + 原因（走全局异常处理器）
    assert res.status_code >= 400 and res.json()['code'] != 200, res.text
    got = client.get(f'/sys/users/me/preferences/{KEY}', headers=token_headers).json()
    assert got['data']['value'] is None, '这次写入应该回滚了'
