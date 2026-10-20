"""MCP 凭据管理接口的守卫测试（真实 HTTP + 测试库）。

要守的都是「写错了不报错」的那一类：

- 明文令牌出现在**不该出现**的地方：详情接口、操作日志的响应体
- 配置写错（拼错用户名 / 工具名、把写工具放进只读入口的白名单）—— 存得进去的话，
  表现是外部系统一律 403 / 某个工具永远调不到，看起来像「凭据坏了」
"""

import asyncio
import json

from collections.abc import Iterator
from typing import Any

import pytest

from sqlalchemy import delete
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.plugin.ai.hooks import MCP_PATH
from backend.plugin.ai.model import AiMcpClient

_MGMT = '/ai/mcp-clients'
_URL = MCP_PATH.removeprefix(settings.FASTAPI_API_V1_PATH)
_PREFIX = 'pytest-mgmt'


@pytest.fixture(autouse=True)
def _purge() -> Iterator[None]:
    """硬删本文件建的凭据（接口的删除是逻辑删除）"""
    yield

    async def _do() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                await db.execute(delete(AiMcpClient).where(AiMcpClient.client_id.like(f'{_PREFIX}%')))
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(_do())


def _create(client: TestClient, headers: dict[str, str], suffix: str = 'a', **cfg: Any) -> Any:
    body = {'client_id': f'{_PREFIX}-{suffix}', 'name': '测试系统', 'act_as': ['test'], **cfg}
    return client.post(_MGMT, headers=headers, json=body)


class TestTokenNeverLeaks:
    def test_plaintext_only_in_the_create_response(self, client: TestClient, token_headers: dict[str, str]) -> None:
        response = _create(client, token_headers)
        issued = response.json()['data']
        token = issued['mcp_token']
        assert token.startswith('fra_mcp_') and len(token) > 40

        detail = client.get(f'{_MGMT}/{issued["id"]}', headers=token_headers)
        listing = client.get(_MGMT, headers=token_headers, params={'page': 1, 'size': 50})
        for body in (detail.text, listing.text):
            # 先断言「有」：确认这条记录真的在响应里，否则「没有令牌」恒真
            assert issued['client_id'] in body
            assert token not in body
            assert 'token_sha256' not in body
        # 辨认用的前缀和真令牌对得上
        assert token.startswith(detail.json()['data']['token_hint'].rstrip('…'))

    def test_opera_log_redacts_the_token(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """拿**真实的**响应字节走一遍操作日志的脱敏 —— 字段名改了、脱敏名单漏了都会红"""
        response = _create(client, token_headers)
        token = response.json()['data']['mcp_token']
        logged = OperaLogMiddleware.redact_body(response.content, 'application/json').decode()
        assert response.json()['data']['client_id'] in logged, '前置：日志里应该有这条记录'
        assert token not in logged
        assert json.loads(logged)['data']['mcp_token'] == '[REDACTED]'

    def test_rotate_response_is_redacted_too(self, client: TestClient, token_headers: dict[str, str]) -> None:
        pk = _create(client, token_headers).json()['data']['id']
        response = client.post(f'{_MGMT}/{pk}/rotate', headers=token_headers)
        token = response.json()['data']['mcp_token']
        assert token not in OperaLogMiddleware.redact_body(response.content, 'application/json').decode()


class TestConfigIsValidatedOnSave:
    @pytest.mark.parametrize(
        ('cfg', 'expect'),
        [
            ({'act_as': ['test', 'no_such_user_xyz']}, 'no_such_user_xyz'),
            ({'tools': ['dept_list', 'no_such_tool']}, 'no_such_tool'),
            ({'tools': ['dept_list', 'dept_create']}, '写操作工具'),
        ],
        ids=['unknown-user', 'unknown-tool', 'mutating-tool'],
    )
    def test_bad_config_is_rejected(
        self, client: TestClient, token_headers: dict[str, str], cfg: dict[str, Any], expect: str
    ) -> None:
        body = _create(client, token_headers, **cfg).json()
        assert body['code'] != 200, body
        assert expect in body['msg'], body

    def test_duplicate_client_id_is_rejected(self, client: TestClient, token_headers: dict[str, str]) -> None:
        assert _create(client, token_headers).json()['code'] == 200
        assert _create(client, token_headers).json()['code'] == 409

    @pytest.mark.parametrize('bad', ['Has-Upper', 'has space', '-leading', 'x' * 49])
    def test_client_id_format(self, client: TestClient, token_headers: dict[str, str], bad: str) -> None:
        body = {'client_id': bad, 'name': '测试系统', 'act_as': ['test']}
        assert client.post(_MGMT, headers=token_headers, json=body).status_code == 422


class TestAccess:
    def test_needs_mcp_permission(self, client: TestClient) -> None:
        """普通员工（STAFF）没有 `ai:mcp:*`：管理接口一律 403，发凭据这件事只有授权的人能做"""
        login = client.post('/auth/login/swagger', params={'username': 'test', 'password': '123456'})
        headers = {'Authorization': f'Bearer {login.json()["access_token"]}'}
        assert client.get(_MGMT, headers=headers).json()['code'] == 403
        body = {'client_id': f'{_PREFIX}-x', 'name': 'x', 'act_as': ['test']}
        assert client.post(_MGMT, headers=headers, json=body).json()['code'] == 403

    def test_last_used_time_is_recorded(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, 'AI_MCP_ENABLED', True)
        issued = _create(client, token_headers).json()['data']
        before = client.get(f'{_MGMT}/{issued["id"]}', headers=token_headers).json()['data']['last_used_time']
        headers = {
            'Authorization': f'Bearer {issued["mcp_token"]}',
            'X-Acting-User': 'test',
            'Accept': 'application/json, text/event-stream',
        }
        assert (
            client.post(_URL, headers=headers, json={'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}).status_code
            == 200
        )
        after = client.get(f'{_MGMT}/{issued["id"]}', headers=token_headers).json()['data']['last_used_time']
        assert before is None
        assert after is not None
