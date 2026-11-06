"""issue #227 后半：OAuth2 的 state 必须绑在发起授权的那个浏览器上（login CSRF）

原来 state 只是 Redis 里的裸 UUID，回调只看「存在且没用过」：攻击者把**自己的**回调地址（自己的 code + state）
发给受害者，受害者就登进了攻击者的账号。现在 authorize 那一跳下发 `fba_oauth2_state` cookie，回调先比对。

路由级测：TestClient 发真请求，第三方换 token 那一步打桩成抛哨兵异常 —— 能走到那一步 = cookie 校验放行了。
"""

from collections.abc import Generator
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse

import pytest

from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.plugin.oauth2.api.v1.github import github_client
from backend.plugin.oauth2.state_binding import STATE_COOKIE_KEY, STATE_COOKIE_PATH, authorize_url


class _ReachedTokenExchange(Exception):  # ruff: ignore[error-suffix-on-exception-name]
    """走到了「拿 code 去第三方换 token」—— 说明前面的 cookie 校验放行了"""


@pytest.fixture
def token_exchange_reached(monkeypatch: pytest.MonkeyPatch) -> None:
    async def boom(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        raise _ReachedTokenExchange

    monkeypatch.setattr(github_client, 'get_access_token', boom)


@pytest.fixture
def fresh_cookies(client: TestClient) -> Generator[TestClient, None, None]:
    """session 级 client 的 cookie jar 是共享的，每条用例前后清空，免得上一条的 state cookie 漏进来"""
    client.cookies.clear()
    yield client
    client.cookies.clear()


def _authorize(client: TestClient, query: str = '') -> tuple[str, SimpleCookie]:
    """打 authorize 入口，返回 (第三方授权页里的 state, 响应设的 cookie)"""
    res = client.get(f'/oauth2/github/authorize{query}', follow_redirects=False)
    assert res.status_code in {302, 307}, res.text
    state = parse_qs(urlparse(res.headers['location']).query)['state'][0]
    jar = SimpleCookie()
    for header in res.headers.get_list('set-cookie'):
        jar.load(header)
    return state, jar


def test_login_url_points_to_the_backend_authorize_entry(fresh_cookies: TestClient) -> None:
    """拿链接的接口形状不变（还是一个字符串），只是指向后端自己的 authorize，而且和回调同一个 host"""
    res = fresh_cookies.get('/oauth2/github')
    url = res.json()['data']
    assert url == authorize_url(settings.OAUTH2_GITHUB_REDIRECT_URI)
    assert urlparse(url).netloc == urlparse(settings.OAUTH2_GITHUB_REDIRECT_URI).netloc
    assert url.endswith('/oauth2/github/authorize')


def test_authorize_sets_a_cookie_equal_to_the_state_sent_to_the_provider(fresh_cookies: TestClient) -> None:
    state, jar = _authorize(fresh_cookies)
    morsel = jar[STATE_COOKIE_KEY]
    assert morsel.value == state
    assert morsel['httponly']
    assert morsel['samesite'].lower() == 'lax'
    assert morsel['path'] == STATE_COOKIE_PATH


@pytest.mark.usefixtures('token_exchange_reached')
def test_callback_without_the_cookie_is_rejected_before_touching_the_provider(fresh_cookies: TestClient) -> None:
    """攻击场景：受害者浏览器里没有这个 state 的 cookie"""
    state, _ = _authorize(fresh_cookies)
    fresh_cookies.cookies.clear()  # 换成「另一个浏览器」

    res = fresh_cookies.get('/oauth2/github/callback', params={'code': 'attacker-code', 'state': state})

    assert res.json()['code'] == 403


@pytest.mark.usefixtures('token_exchange_reached')
def test_callback_with_someone_elses_state_is_rejected(fresh_cookies: TestClient) -> None:
    """受害者自己走过一次 authorize（有 cookie），却被塞了攻击者的 state"""
    _authorize(fresh_cookies)  # 受害者自己的 cookie
    res = fresh_cookies.get('/oauth2/github/callback', params={'code': 'attacker-code', 'state': 'attacker-state'})
    assert res.json()['code'] == 403


@pytest.mark.usefixtures('token_exchange_reached')
def test_callback_with_the_matching_cookie_goes_on_to_the_token_exchange(fresh_cookies: TestClient) -> None:
    """对照组：同一个浏览器回来，cookie 校验放行（否则上面两条「拒绝」可能只是什么都拒绝）"""
    state, jar = _authorize(fresh_cookies)
    fresh_cookies.cookies.set(STATE_COOKIE_KEY, jar[STATE_COOKIE_KEY].value, path=STATE_COOKIE_PATH)

    with pytest.raises(_ReachedTokenExchange):
        fresh_cookies.get('/oauth2/github/callback', params={'code': 'my-code', 'state': state})


def test_binding_ticket_can_only_be_claimed_once(fresh_cookies: TestClient, token_headers: dict[str, str]) -> None:
    """绑定链接带一次性 ticket：第一个打开的浏览器认领，之后再打开就失效"""
    res = fresh_cookies.get('/oauth2/me/binding', params={'source': 'Github'}, headers=token_headers)
    url = res.json()['data']
    assert urlparse(url).path.endswith('/oauth2/github/authorize')
    ticket = parse_qs(urlparse(url).query)['ticket'][0]

    state, jar = _authorize(fresh_cookies, f'?ticket={ticket}')
    assert state == ticket
    assert jar[STATE_COOKIE_KEY].value == ticket

    again = fresh_cookies.get(f'/oauth2/github/authorize?ticket={ticket}', follow_redirects=False)
    assert again.json()['code'] == 403


def test_unknown_ticket_is_rejected(fresh_cookies: TestClient) -> None:
    res = fresh_cookies.get('/oauth2/github/authorize?ticket=not-a-real-state', follow_redirects=False)
    assert res.json()['code'] == 403


def test_rejected_login_goes_back_to_the_frontend_with_the_reason(
    fresh_cookies: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """业务层拒绝（这里是 #226 的「陌生账号不建号」）要 302 回前端落地页，带着原因

    回调是第三方 → 后端的顶层跳转：原来异常直接抛出去，浏览器停在 API 域名上一页裸 JSON、回不到前端。
    #226 之后这是每个新用户第一次社交登录的默认路径。
    """
    from backend.plugin.oauth2.api.v1 import github as github_api

    async def token(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        return {'access_token': 'gh-token'}

    async def userinfo(*_: object, **__: object) -> dict:  # ruff:ignore[unused-async]
        return {'id': 987654321123, 'login': 'stranger-0x', 'name': 'stranger', 'email': None}

    async def unverified(*_: object, **__: object) -> bool:  # ruff:ignore[unused-async]
        return False

    monkeypatch.setattr(github_client, 'get_access_token', token)
    monkeypatch.setattr(github_client, 'get_userinfo', userinfo)
    monkeypatch.setattr(github_api, 'github_email_verified', unverified)
    monkeypatch.setattr(settings, 'OAUTH2_AUTO_REGISTER', False)

    state, jar = _authorize(fresh_cookies)
    fresh_cookies.cookies.set(STATE_COOKIE_KEY, jar[STATE_COOKIE_KEY].value, path=STATE_COOKIE_PATH)
    res = fresh_cookies.get(
        '/oauth2/github/callback', params={'code': 'my-code', 'state': state}, follow_redirects=False
    )

    assert res.status_code in {302, 307}, res.text
    location = urlparse(res.headers['location'])
    assert f'{location.scheme}://{location.netloc}{location.path}' == settings.OAUTH2_FRONTEND_LOGIN_REDIRECT_URI
    assert parse_qs(location.query)['error'][0], '要带上拒绝的原因，前端落地页拿它显示'
    # 用过的 state cookie 一并清掉（同成功路径）
    assert any(h.startswith(f'{STATE_COOKIE_KEY}=""') for h in res.headers.get_list('set-cookie'))
