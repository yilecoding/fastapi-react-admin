"""#402 第 1 条：第三方登录建的无密码账号设不上密码

`sys_user.password` 为 NULL 的账号（`OAUTH2_AUTO_REGISTER` 建的）：

- 原来自助改密 / 超管重置都在 `CreateUserPasswordHistoryParam(password=None)` 上抛 ValidationError —— 永远设不上
- 自助那条同时**跳过了旧密码校验**（`if user.password and ...`），是那个异常在兜底。只把 None 放过去，
  拿到一枚 access token 的人就能给别人设一个长期密码 → 第一次设密码必须重新走一遍已绑定的第三方授权

路由级测：TestClient 发真请求，第三方换 token / 拉用户信息打桩。账号的第三方绑定也走真实的绑定流程建出来。
"""

import asyncio

from collections.abc import Iterator
from urllib.parse import parse_qs, urlparse

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.oauth2.api.v1 import github as github_api
from backend.plugin.oauth2.api.v1.github import github_client
from backend.plugin.oauth2.state_binding import STATE_COOKIE_KEY, STATE_COOKIE_PATH

USERNAME = 'pytest_nopwd_402'
SEED_PASSWORD = 'Tmp@123456'
NEW = 'Nw1@abcdef'
MY_SID = 402000111
OTHER_SID = 402000999


def _sql(statement: str, **params: object) -> list:
    """另起引擎跑一句（共享会话绑在 TestClient 的事件循环上，见 app/admin/tests/conftest.py）"""

    async def run() -> list:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as session:
                result = await session.execute(text(statement), params)
                return list(result.all()) if result.returns_rows else []
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _stored_password(pk: int) -> str | None:
    return _sql('SELECT password FROM sys_user WHERE id = :pk', pk=pk)[0][0]


def _stub_github(monkeypatch: pytest.MonkeyPatch, sid: int) -> None:
    async def token(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        return {'access_token': 'gh-token'}

    async def userinfo(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        return {'id': sid, 'login': f'gh-{sid}', 'name': 'gh', 'email': None}

    async def unverified(*_: object, **__: object) -> bool:  # ruff:ignore[unused-async]
        return False

    monkeypatch.setattr(github_client, 'get_access_token', token)
    monkeypatch.setattr(github_client, 'get_userinfo', userinfo)
    monkeypatch.setattr(github_api, 'github_email_verified', unverified)


def _run_ticket_flow(client: TestClient, url: str) -> object:
    """拿到的授权链接（带 ticket）→ authorize（下发 cookie）→ 回调。返回回调的响应"""
    path = urlparse(url)
    res = client.get(f'{path.path.removeprefix(settings.FASTAPI_API_V1_PATH)}?{path.query}', follow_redirects=False)
    assert res.status_code in {302, 307}, res.text
    state = parse_qs(urlparse(res.headers['location']).query)['state'][0]
    client.cookies.set(STATE_COOKIE_KEY, state, path=STATE_COOKIE_PATH)
    return client.get('/oauth2/github/callback', params={'code': 'c', 'state': state}, follow_redirects=False)


def _reauth(client: TestClient, headers: dict, monkeypatch: pytest.MonkeyPatch, sid: int) -> object:
    _stub_github(monkeypatch, sid)
    res = client.get('/oauth2/me/reauth', params={'source': 'Github'}, headers=headers)
    assert res.json()['code'] == 200, res.text
    return _run_ticket_flow(client, res.json()['data'])


@pytest.fixture
def passwordless(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> Iterator[tuple[int, dict]]:
    """一个绑了 GitHub（sid=MY_SID）、密码为 NULL、手里有一个有效会话的账号"""
    client.cookies.clear()
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']
    res = client.post(
        '/sys/users',
        headers=token_headers,
        json={
            'username': USERNAME,
            'password': SEED_PASSWORD,
            'nickname': '无密码',
            'dept_id': dept_id,
            'roles': [role_id],
        },
    )
    assert res.json()['code'] == 200, res.text
    pk = int(res.json()['data']['id'])
    try:
        body = client.post('/auth/login/swagger', params={'username': USERNAME, 'password': SEED_PASSWORD}).json()
        headers = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}

        # 真实绑定流程建出第三方绑定
        _stub_github(monkeypatch, MY_SID)
        url = client.get('/oauth2/me/binding', params={'source': 'Github'}, headers=headers).json()['data']
        _run_ticket_flow(client, url)
        assert _sql('SELECT 1 FROM sys_user_social WHERE user_id = :pk', pk=pk), '前置：绑定没建出来'

        # 变成第三方建出来的那种号：没有密码
        _sql('UPDATE sys_user SET password = NULL WHERE id = :pk', pk=pk)
        assert client.get('/sys/users/me', headers=headers).status_code == 200, '前置：会话要还能用'
        yield pk, headers
    finally:
        client.cookies.clear()
        for table in ('sys_user_social', 'sys_user_password_history', 'sys_user_role'):
            _sql(f'DELETE FROM {table} WHERE user_id = :pk', pk=pk)
        _sql('DELETE FROM sys_user WHERE id = :pk', pk=pk)


def _set_first_password(client: TestClient, headers: dict, password: str = NEW) -> dict:
    return client.put(
        '/sys/users/me/password', headers=headers, json={'new_password': password, 'confirm_password': password}
    ).json()


def test_password_status_says_there_is_no_password(client: TestClient, passwordless: tuple[int, dict]) -> None:
    _, headers = passwordless
    data = client.get('/sys/users/me/password-status', headers=headers).json()['data']
    assert data == {'has_password': False, 'reauth_verified': False}


def test_without_reauth_a_token_alone_cannot_set_a_password(client: TestClient, passwordless: tuple[int, dict]) -> None:
    """🔴 只拿着一个会话（比如被盗的 access token）不能给无密码账号设密码"""
    pk, headers = passwordless
    for body in (
        {'new_password': NEW, 'confirm_password': NEW},
        {'old_password': 'x', 'new_password': NEW, 'confirm_password': NEW},
    ):
        res = client.put('/sys/users/me/password', headers=headers, json=body)
        assert res.json()['code'] != 200, res.text
    assert _stored_password(pk) is None, '被拒了，密码却被写进去了'


def test_reauth_with_the_bound_account_lets_the_user_set_a_first_password(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    pk, headers = passwordless
    cb = _reauth(client, headers, monkeypatch, MY_SID)
    assert cb.status_code in {302, 307}
    landing = urlparse(cb.headers['location'])
    assert f'{landing.scheme}://{landing.netloc}{landing.path}' == settings.OAUTH2_FRONTEND_BINDING_REDIRECT_URI
    assert 'error' not in parse_qs(landing.query)

    status = client.get('/sys/users/me/password-status', headers=headers).json()['data']
    assert status == {'has_password': False, 'reauth_verified': True}

    res = _set_first_password(client, headers)
    assert res['code'] == 200, res
    assert _stored_password(pk) is not None
    # 新密码真能登录
    assert client.post('/auth/login/swagger', params={'username': USERNAME, 'password': NEW}).status_code == 200


def test_reauth_with_some_other_github_account_grants_nothing(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """授权回来的第三方账号不是绑在这个人名下的那一个 → 不算确认身份"""
    pk, headers = passwordless
    cb = _reauth(client, headers, monkeypatch, OTHER_SID)
    assert parse_qs(urlparse(cb.headers['location']).query).get('error'), '要带着原因回前端'

    assert client.get('/sys/users/me/password-status', headers=headers).json()['data']['reauth_verified'] is False
    assert _set_first_password(client, headers)['code'] != 200
    assert _stored_password(pk) is None


def test_a_rejected_password_does_not_burn_the_reauth(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """复杂度不过被拒，不该让用户再跑一遍第三方授权；凭据在真正写入时才消费"""
    _, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)
    assert _set_first_password(client, headers, '123')['code'] != 200
    assert _set_first_password(client, headers)['code'] == 200


def test_the_reauth_is_single_use(
    client: TestClient, passwordless: tuple[int, dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    """设完之后凭据就没了（之后改密码走「验旧密码」那条路）"""
    _, headers = passwordless
    _reauth(client, headers, monkeypatch, MY_SID)
    assert _set_first_password(client, headers)['code'] == 200
    body = client.post('/auth/login/swagger', params={'username': USERNAME, 'password': NEW}).json()
    fresh = {'Authorization': f'{body["token_type"]} {body["access_token"]}'}
    assert client.get('/sys/users/me/password-status', headers=fresh).json()['data'] == {
        'has_password': True,
        'reauth_verified': False,
    }


def test_reauth_link_needs_a_bound_account(client: TestClient, passwordless: tuple[int, dict]) -> None:
    """没绑 Google 就拿不到 Google 的重新验证链接（不然走完授权也只会被拒，白跳一趟）"""
    _, headers = passwordless
    res = client.get('/oauth2/me/reauth', params={'source': 'Google'}, headers=headers)
    assert res.json()['code'] != 200


def test_passwordless_account_cannot_unbind_its_last_login(client: TestClient, passwordless: tuple[int, dict]) -> None:
    """解绑最后一个第三方账号 = 这个号再也登不进来，也没有东西能证明身份去设密码"""
    pk, headers = passwordless
    res = client.delete('/oauth2/me/unbinding', params={'source': 'Github'}, headers=headers)
    assert res.json()['code'] != 200, res.text
    assert _sql('SELECT 1 FROM sys_user_social WHERE user_id = :pk', pk=pk)


def test_superuser_can_reset_a_passwordless_account(
    client: TestClient, token_headers: dict[str, str], passwordless: tuple[int, dict]
) -> None:
    """超管重置原来同样在 `password=None` 的历史记录上炸"""
    pk, _ = passwordless
    res = client.put(f'/sys/users/{pk}/password', headers=token_headers, json={'password': NEW})
    assert res.json()['code'] == 200, res.text
    assert client.post('/auth/login/swagger', params={'username': USERNAME, 'password': NEW}).status_code == 200
