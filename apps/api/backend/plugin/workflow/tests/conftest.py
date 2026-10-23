import asyncio
import uuid

from collections.abc import Callable, Generator
from typing import Any

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

PASSWORD = '123456'


def key() -> str:
    return uuid.uuid4().hex


def _purge() -> None:
    """硬删审批数据。

    种子里没有任何实例，所以实例 / 待办 / 轨迹 / 抄送整表清；定义只清 `PYTEST_` 开头的
    （`LEAVE` 是种子）。站内通知只清审批分类（3）。
    ⚠️ 接口层的删除是逻辑删除，靠它清理会每跑一次堆一批行（tests 分册「收尾必须硬删」）。
    """

    async def run() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        maker = create_database_async_session(engine)
        try:
            async with maker.begin() as s:
                for table in ('wf_ai_review', 'wf_cc', 'wf_action_record', 'wf_task', 'wf_instance'):
                    await s.execute(text(f'DELETE FROM {table}'))
                await s.execute(
                    text(
                        'DELETE FROM wf_definition_version WHERE definition_id IN '
                        "(SELECT id FROM wf_definition WHERE code LIKE 'PYTEST%')"
                    )
                )
                await s.execute(text("DELETE FROM wf_definition WHERE code LIKE 'PYTEST%'"))
                await s.execute(
                    text(
                        'DELETE FROM sys_notification_read WHERE notification_id IN '
                        '(SELECT id FROM sys_notification WHERE category = 3)'
                    )
                )
                await s.execute(text('DELETE FROM sys_notification WHERE category = 3'))
        finally:
            await engine.dispose()

    asyncio.run(run())


@pytest.fixture(scope='module', autouse=True)
def _clean_workflow_data() -> Generator[None, None, None]:
    _purge()
    yield
    _purge()


@pytest.fixture(scope='module')
def login(client: TestClient) -> Callable[[str], dict[str, str]]:
    cache: dict[str, dict[str, str]] = {}

    def _login(username: str) -> dict[str, str]:
        if username not in cache:
            resp = client.post('/auth/login/swagger', params={'username': username, 'password': PASSWORD})
            assert resp.status_code == 200, resp.text
            body = resp.json()
            cache[username] = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}
        return cache[username]

    return _login


@pytest.fixture(scope='module')
def uid(client: TestClient, token_headers: dict[str, str]) -> Callable[[str], str]:
    """用户名 → 用户 ID（字符串）。三个方言的种子 ID 不一样，不能写死"""
    cache: dict[str, str] = {}

    def _uid(username: str) -> str:
        if username not in cache:
            data = client.get('/sys/users', headers=token_headers, params={'username': username}).json()['data']
            hits = [u for u in data['items'] if u['username'] == username]
            assert len(hits) == 1, f'找不到用户 {username}'
            cache[username] = str(hits[0]['id'])
        return cache[username]

    return _uid


def ok(resp: Any) -> Any:
    body = resp.json()
    assert resp.status_code == 200 and body['code'] == 200, resp.text
    return body['data']
