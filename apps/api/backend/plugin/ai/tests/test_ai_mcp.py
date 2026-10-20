"""MCP 网关的守卫测试 —— 全部走真实 HTTP（TestClient → JWT 中间件 → 网关 → dispatcher → 测试库）。

身份是外部系统**声明**的，所以这里测的主要是「声明能被信到哪一步」：

- 凭据不对 / 缺代理用户 / 代理了白名单外的人 / 代理超管 —— 都在 HTTP 层拒掉，进不了协议层
- 代理成功后，权限按**被代理的那个人**算：他自己没权限的工具，清单里没有、硬调也被拒
- 写操作在这个入口一律拒绝，且**拒绝要进审计**（带上是哪个系统）
- 凭据的 `tools` 白名单只能收窄

⚠️ 网关路径必须在 JWT 中间件的放行名单里：外部系统的 Bearer 不是 JWT，不放行会先被
中间件当成坏 token 拒掉（401「Token 无效」）—— 下面每条「成功」用例都隐含验证了这一点。
"""

import asyncio

from collections.abc import Iterator
from typing import Any

import pytest

from sqlalchemy import delete, select
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.ai.enums import ToolInvocationStatus
from backend.plugin.ai.hooks import MCP_PATH
from backend.plugin.ai.mcp_gateway.auth import hash_token
from backend.plugin.ai.model import AiToolInvocation

_URL = MCP_PATH.removeprefix(settings.FASTAPI_API_V1_PATH)  # client 的 base_url 已带 /api/v1
_TOKEN = 'fra_mcp_pytest-token'
_CHANNEL = 'mcp:pytest'


def _client_cfg(**overrides: Any) -> dict[str, Any]:
    return {'id': 'pytest', 'token_sha256': hash_token(_TOKEN), 'act_as': ['*'], **overrides}


@pytest.fixture
def gateway(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """打开网关；返回一个可改凭据配置的函数"""
    monkeypatch.setattr(settings, 'AI_MCP_ENABLED', True)
    monkeypatch.setattr(settings, 'AI_MCP_CLIENTS', [_client_cfg(allow_superuser=True)])

    def configure(**overrides: Any) -> None:
        monkeypatch.setattr(settings, 'AI_MCP_CLIENTS', [_client_cfg(**overrides)])

    yield configure


@pytest.fixture(scope='module', autouse=True)
def _cleanup_audit() -> Iterator[None]:
    """审计行硬删 —— 走接口删不了，也不该留在测试库里越积越多"""
    yield

    async def _purge() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                await db.execute(delete(AiToolInvocation).where(AiToolInvocation.channel == _CHANNEL))
                await db.commit()
        finally:
            await engine.dispose()

    asyncio.run(_purge())


def _rpc(
    client: TestClient,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    user: str | None = 'admin',
    token: str = _TOKEN,
) -> Any:
    headers = {'Accept': 'application/json, text/event-stream'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    if user is not None:
        headers['X-Acting-User'] = user
    return client.post(
        _URL, headers=headers, json={'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}
    )


def _tools(client: TestClient, **kwargs: Any) -> set[str]:
    response = _rpc(client, 'tools/list', **kwargs)
    assert response.status_code == 200, response.text
    return {t['name'] for t in response.json()['result']['tools']}


def _call(client: TestClient, name: str, arguments: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    response = _rpc(client, 'tools/call', {'name': name, 'arguments': arguments or {}}, **kwargs)
    assert response.status_code == 200, response.text
    return response.json()['result']


def _audit_rows(tool: str) -> list[tuple[int, str | None]]:
    async def _q() -> list[tuple[int, str | None]]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                rows = await db.execute(
                    select(AiToolInvocation.status, AiToolInvocation.channel).where(
                        AiToolInvocation.tool_name == tool, AiToolInvocation.channel == _CHANNEL
                    )
                )
                return [tuple(r) for r in rows]
        finally:
            await engine.dispose()

    return asyncio.run(_q())


class TestAuthentication:
    def test_disabled_gateway_is_404(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, 'AI_MCP_ENABLED', False)
        assert _rpc(client, 'tools/list').status_code == 404

    @pytest.mark.parametrize(
        ('kwargs', 'status'),
        [
            ({'token': ''}, 401),
            ({'token': 'wrong'}, 401),
            ({'user': None}, 400),
            ({'user': 'no_such_user'}, 403),
        ],
        ids=['no-token', 'bad-token', 'no-acting-user', 'unknown-user'],
    )
    def test_rejected_before_protocol(self, client: TestClient, gateway: Any, kwargs: dict, status: int) -> None:
        response = _rpc(client, 'tools/list', **kwargs)
        assert response.status_code == status, response.text
        assert 'jsonrpc' not in response.text, '鉴权失败的请求不该进入 MCP 协议层'

    def test_cannot_act_outside_allowlist(self, client: TestClient, gateway: Any) -> None:
        gateway(act_as=['test'])
        assert _rpc(client, 'tools/list', user='test').status_code == 200
        assert _rpc(client, 'tools/list', user='zhangwei').status_code == 403

    def test_superuser_needs_explicit_permission(self, client: TestClient, gateway: Any) -> None:
        gateway()  # allow_superuser 默认 False
        response = _rpc(client, 'tools/list', user='admin')
        assert response.status_code == 403
        assert '超级管理员' in response.json()['error']

    def test_broken_client_config_is_ignored_not_widened(self, client: TestClient, gateway: Any) -> None:
        gateway(token_sha256='not-a-sha256')
        assert _rpc(client, 'tools/list').status_code == 401


class TestToolsFollowTheActingUser:
    def test_list_has_read_tools_only(self, client: TestClient, gateway: Any) -> None:
        names = _tools(client)
        # 先断言「有」：清单空了的话下面那句「没有写工具」恒真
        assert {'dept_list', 'system_health_check'} <= names
        assert not names & {'dept_create', 'dept_rename'}

    def test_list_narrows_to_acting_users_permissions(self, client: TestClient, gateway: Any) -> None:
        admin_view = _tools(client, user='admin')
        staff_view = _tools(client, user='test')  # STAFF：只有仪表盘和个人中心
        assert staff_view < admin_view
        assert 'dept_list' not in staff_view

    def test_client_tool_allowlist_only_narrows(self, client: TestClient, gateway: Any) -> None:
        gateway(allow_superuser=True, tools=['system_health_check', 'dept_create'])
        # dept_create 写进了白名单也不出现：白名单不能把只读入口放大成可写
        assert _tools(client) == {'system_health_check'}
        result = _call(client, 'dept_list')
        assert result['isError'] is True


class TestCalls:
    def test_read_tool_runs_and_is_audited_with_channel(self, client: TestClient, gateway: Any) -> None:
        result = _call(client, 'dept_list')
        assert result['isError'] is False, result
        assert 'HQ' in result['content'][0]['text']
        assert (ToolInvocationStatus.SUCCESS.value, _CHANNEL) in _audit_rows('dept_list')

    def test_tool_without_permission_is_denied(self, client: TestClient, gateway: Any) -> None:
        result = _call(client, 'dept_list', user='test')
        assert result['isError'] is True
        assert (ToolInvocationStatus.DENIED.value, _CHANNEL) in _audit_rows('dept_list')

    def test_mutating_tool_is_refused_and_audited(self, client: TestClient, gateway: Any) -> None:
        """不在清单里也要能拒：清单只是展示，外部系统完全可以直接调名字"""
        result = _call(client, 'dept_create', {'name': '不该建出来', 'code': 'MCP_NOPE'})
        assert result['isError'] is True
        assert '网页端' in result['content'][0]['text']
        assert (ToolInvocationStatus.DENIED.value, _CHANNEL) in _audit_rows('dept_create')
