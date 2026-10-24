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
import json
import re
import uuid

from collections.abc import Iterator
from typing import Any

import pytest

from sqlalchemy import delete, or_, select
from starlette.testclient import TestClient

from backend.app.admin.model import Dept
from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import RedisCli
from backend.plugin.ai.enums import ToolInvocationStatus
from backend.plugin.ai.hooks import MCP_PATH
from backend.plugin.ai.model import AiMcpClient, AiToolInvocation

_URL = MCP_PATH.removeprefix(settings.FASTAPI_API_V1_PATH)  # client 的 base_url 已带 /api/v1
_MGMT = '/ai/mcp-clients'
_CLIENT_ID = 'pytest'
_CHANNEL = f'mcp:{_CLIENT_ID}'
# 当前这条用例的凭据（gateway fixture 经管理接口真实创建）
_state: dict[str, Any] = {}


def _run_db(coro_fn: Any) -> Any:
    async def _main() -> Any:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                return await coro_fn(db)
        finally:
            await engine.dispose()

    return asyncio.run(_main())


def _purge_clients() -> None:
    """凭据硬删：接口的删除是逻辑删除，`client_id` 又要在下一条用例里复用"""

    async def _do(db: Any) -> None:
        await db.execute(
            delete(AiMcpClient).where(or_(AiMcpClient.client_id == _CLIENT_ID, AiMcpClient.client_id.like('rl-%')))
        )
        await db.commit()

    _run_db(_do)


def _create_client(client: TestClient, headers: dict[str, str], **cfg: Any) -> dict[str, Any]:
    response = client.post(_MGMT, headers=headers, json={'name': cfg.get('client_id', 'pytest'), **cfg})
    assert response.json()['code'] == 200, response.text
    return response.json()['data']


@pytest.fixture
def gateway(client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    """打开网关、经管理接口建一份凭据（可代表任何人含超管）；返回一个改这份凭据配置的函数"""
    monkeypatch.setattr(settings, 'AI_MCP_ENABLED', True)
    _purge_clients()
    created = _create_client(client, token_headers, client_id=_CLIENT_ID, act_as=['*'], allow_superuser=True)
    _state.update(token=created['mcp_token'], pk=created['id'])

    def configure(**overrides: Any) -> None:
        body = {'name': 'pytest', 'act_as': ['*'], **overrides}
        response = client.put(f'{_MGMT}/{_state["pk"]}', headers=token_headers, json=body)
        assert response.json()['code'] == 200, response.text

    try:
        yield configure
    finally:
        _purge_clients()
        _state.clear()


@pytest.fixture(scope='module', autouse=True)
def _cleanup_audit() -> Iterator[None]:
    """审计行硬删 —— 走接口删不了，也不该留在测试库里越积越多"""
    yield

    async def _do(db: Any) -> None:
        await db.execute(delete(AiToolInvocation).where(AiToolInvocation.channel.like('mcp:%')))
        await db.commit()

    _run_db(_do)


def _rpc(
    client: TestClient,
    method: str,
    params: dict[str, Any] | None = None,
    *,
    user: str | None = 'admin',
    token: str | None = None,
) -> Any:
    token = _state.get('token', '') if token is None else token
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
    async def _q(db: Any) -> list[tuple[int, str | None]]:
        rows = await db.execute(
            select(AiToolInvocation.status, AiToolInvocation.channel).where(
                AiToolInvocation.tool_name == tool, AiToolInvocation.channel == _CHANNEL
            )
        )
        return [tuple(r) for r in rows]

    return _run_db(_q)


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

    def test_disabled_ai_plugin_closes_the_gateway(self, client: TestClient, gateway: Any) -> None:
        """🔴 网关是 `hooks.py` 直接挂在主应用上的 Route，不经过插件路由那道 `PluginStatusChecker` ——
        原来在插件管理里停用 AI 插件，网页对话关掉了，外部系统经 MCP 照样能调工具"""
        gateway(act_as=['test'])
        assert _rpc(client, 'tools/list', user='test').status_code == 200, '启用时要通（先断言「有」）'
        key = f'{settings.PLUGIN_REDIS_PREFIX}:ai'

        async def flip(value: str | None, before: str | None = None) -> str | None:
            redis = RedisCli()
            try:
                current = await redis.get(key)
                if value is None:
                    await (redis.set(key, before) if before is not None else redis.delete(key))
                else:
                    info = json.loads(current) if current else {'plugin': {}}
                    info['plugin']['enable'] = value
                    await redis.set(key, json.dumps(info, ensure_ascii=False))
                return current
            finally:
                await redis.aclose()

        original = asyncio.run(flip('0'))
        try:
            response = _rpc(client, 'tools/list', user='test')
            assert response.status_code == 404, response.text
            assert 'jsonrpc' not in response.text
        finally:
            asyncio.run(flip(None, original))

    def test_superuser_needs_explicit_permission(self, client: TestClient, gateway: Any) -> None:
        gateway()  # allow_superuser 默认 False
        response = _rpc(client, 'tools/list', user='admin')
        assert response.status_code == 403
        assert '超级管理员' in response.json()['error']


class TestCredentialLifecycle:
    """凭据的停用 / 换令牌 / 删除都要**即刻**生效 —— 网关每个请求按哈希现查，不缓存"""

    def test_disabled_credential_is_rejected_immediately(self, client: TestClient, gateway: Any) -> None:
        assert _rpc(client, 'tools/list').status_code == 200
        gateway(allow_superuser=True, status=0)
        assert _rpc(client, 'tools/list').status_code == 401

    def test_rotated_token_invalidates_the_old_one(
        self, client: TestClient, token_headers: dict[str, str], gateway: Any
    ) -> None:
        old = _state['token']
        response = client.post(f'{_MGMT}/{_state["pk"]}/rotate', headers=token_headers)
        new = response.json()['data']['mcp_token']
        assert new != old
        assert _rpc(client, 'tools/list', token=old).status_code == 401
        assert _rpc(client, 'tools/list', token=new).status_code == 200

    def test_deleted_credential_is_rejected(
        self, client: TestClient, token_headers: dict[str, str], gateway: Any
    ) -> None:
        assert client.delete(f'{_MGMT}/{_state["pk"]}', headers=token_headers).json()['code'] == 200
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
        # 写操作工具连白名单都进不去（管理接口拒，见 test_ai_mcp_clients.py）；这里验的是收窄
        gateway(allow_superuser=True, tools=['system_health_check'])
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


class TestRateLimit:
    """按凭据限流。用唯一的凭据 ID：Redis 里的计数窗口是一分钟，固定 ID 会让上一轮的计数漏进这一轮"""

    @staticmethod
    def _two_clients(
        client: TestClient, headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, rate: int
    ) -> tuple[str, str]:
        monkeypatch.setattr(settings, 'AI_MCP_ENABLED', True)
        a = _create_client(
            client, headers, client_id=f'rl-{uuid.uuid4().hex[:8]}', act_as=['test', 'lina'], rate_per_minute=rate
        )
        b = _create_client(
            client, headers, client_id=f'rl-{uuid.uuid4().hex[:8]}', act_as=['test'], rate_per_minute=rate
        )
        return a['mcp_token'], b['mcp_token']

    @pytest.fixture(autouse=True)
    def _purge(self) -> Iterator[None]:
        yield
        _purge_clients()

    def test_over_quota_is_429_with_retry_after(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, rate_limiter: None
    ) -> None:
        token, _ = self._two_clients(client, token_headers, monkeypatch, rate=3)
        codes = [_rpc(client, 'tools/list', user='test', token=token).status_code for _ in range(3)]
        # 先断言「额度内都放行」：否则 429 可能只是因为别的原因一开始就全挡了
        assert codes == [200, 200, 200]
        over = _rpc(client, 'tools/list', user='test', token=token)
        assert over.status_code == 429
        assert int(over.headers['Retry-After']) > 0
        assert 'jsonrpc' not in over.text, '被限流的请求不该进入 MCP 协议层'

    def test_switching_acting_user_does_not_reset_quota(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, rate_limiter: None
    ) -> None:
        """额度按凭据算：一份凭据轮换着代表不同的人，不能换来新额度"""
        token, _ = self._two_clients(client, token_headers, monkeypatch, rate=2)
        assert _rpc(client, 'tools/list', user='test', token=token).status_code == 200
        assert _rpc(client, 'tools/list', user='lina', token=token).status_code == 200
        assert _rpc(client, 'tools/list', user='lina', token=token).status_code == 429

    def test_clients_have_separate_quotas(
        self, client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, rate_limiter: None
    ) -> None:
        token_a, token_b = self._two_clients(client, token_headers, monkeypatch, rate=1)
        assert _rpc(client, 'tools/list', user='test', token=token_a).status_code == 200
        assert _rpc(client, 'tools/list', user='test', token=token_a).status_code == 429
        assert _rpc(client, 'tools/list', user='test', token=token_b).status_code == 200


class TestWriteViaWebConfirm:
    """凭据开了 `allow_write`：写操作**只预演、不执行**，回网页由被代表的人本人确认。

    外部系统声明的身份，要到「本人登录网页点确认」这一步才被兑现 —— 所以这里的要害是：
    MCP 那一侧无论怎么调，库里都不能多出东西；只有网页确认之后才有。
    """

    _CODE = 'MCP_WRITE_PYTEST'

    @pytest.fixture(autouse=True)
    def _purge_dept(self) -> Iterator[None]:
        yield

        async def _do(db: Any) -> None:
            await db.execute(delete(Dept).where(Dept.code == self._CODE))
            await db.commit()

        _run_db(_do)

    def _stage(self, client: TestClient) -> tuple[dict[str, Any], str]:
        result = _call(client, 'dept_create', {'name': 'MCP 写操作测试', 'code': self._CODE})
        text = result['content'][0]['text']
        match = re.search(r'/ai/confirm\?token=(\S+)', text)
        return result, match.group(1) if match else ''

    @staticmethod
    def _dept_exists(code: str) -> bool:
        async def _q(db: Any) -> bool:
            return (await db.execute(select(Dept.id).where(Dept.code == code, Dept.deleted == 0))).first() is not None

        return _run_db(_q)

    def test_write_tools_listed_only_when_allowed(self, client: TestClient, gateway: Any) -> None:
        assert 'dept_create' not in _tools(client)
        gateway(allow_superuser=True, allow_write=True)
        response = _rpc(client, 'tools/list')
        tools = {t['name']: t for t in response.json()['result']['tools']}
        assert 'dept_create' in tools
        assert tools['dept_create']['annotations']['readOnlyHint'] is False

    def test_mcp_only_stages_and_web_confirm_executes(
        self, client: TestClient, token_headers: dict[str, str], gateway: Any
    ) -> None:
        gateway(allow_superuser=True, allow_write=True)
        result, token = self._stage(client)
        assert result['isError'] is False, result
        assert '还没有执行' in result['content'][0]['text']
        assert token.startswith('cf_'), f'令牌要带字母前缀，否则路由层可能把它 JSON.parse 成数字：{token}'
        assert not self._dept_exists(self._CODE), 'MCP 一侧就把部门建出来了 —— 没等本人确认'

        pending = client.get(f'/ai/chat/tools/confirm/{token}', headers=token_headers).json()
        assert pending['code'] == 200, pending
        assert pending['data']['channel'] == _CHANNEL
        assert 'MCP 写操作测试' in pending['data']['preview']
        assert not self._dept_exists(self._CODE), '查看预演不该消费令牌、更不该执行'

        with client.stream('POST', '/ai/chat/tools/confirm', headers=token_headers, json={'token': token}) as r:
            frames = [json.loads(line[6:]) for line in r.iter_lines() if line.startswith('data: ')]
        assert any(f['type'] == 'tool_result' and f['ok'] for f in frames), frames
        assert self._dept_exists(self._CODE)
        # 执行那一行审计仍记作 MCP 发起（确认令牌把 channel 带过来了）
        assert (ToolInvocationStatus.SUCCESS.value, _CHANNEL) in _audit_rows('dept_create')

    def test_someone_elses_token_reveals_nothing(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """链接会经过外部系统、聊天记录 —— 别人拿到也看不到要改什么"""

        async def _stage_for_other() -> str:
            redis = RedisCli()
            try:
                token = f'cf_{uuid.uuid4().hex}'
                payload = {'tool': 'dept_create', 'arguments': {}, 'user_id': '1', 'conversation_id': '0',
                           'channel': _CHANNEL, 'preview': '机密的预演内容'}  # fmt: skip
                await redis.set(f'{settings.AI_CONFIRM_REDIS_PREFIX}:{token}', json.dumps(payload), ex=60)
                return token
            finally:
                await redis.aclose()

        token = asyncio.run(_stage_for_other())
        body = client.get(f'/ai/chat/tools/confirm/{token}', headers=token_headers).json()
        assert body['code'] == 403, body
        assert '机密的预演内容' not in json.dumps(body, ensure_ascii=False)

    def test_acting_user_without_ai_permission_gets_no_dead_link(self, client: TestClient, gateway: Any) -> None:
        """被代表的人没有 ai:chat:use 就点不了网页确认 —— 不发一个永远点不了的链接"""
        gateway(allow_write=True)
        result = _call(client, 'dept_create', {'name': 'x', 'code': self._CODE}, user='test')
        assert result['isError'] is True
        assert 'ai:chat:use' in result['content'][0]['text']
        assert '/ai/confirm' not in result['content'][0]['text']
