"""TLS 卸载后的 Cookie 属性：用真实 Uvicorn 代理中间件和 Cookie 设置函数验证。"""

import time

from http.cookies import SimpleCookie

import pytest

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route
from starlette.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from backend.common.security.jwt import clear_refresh_cookie, set_refresh_cookie
from backend.core.conf import settings
from backend.plugin.oauth2.state_binding import STATE_COOKIE_KEY, clear_state_cookie, set_state_cookie


@pytest.mark.parametrize(
    ('cookie_secure', 'proto', 'trusted', 'expected'),
    [
        (None, 'https', True, True),
        (None, 'http', True, False),
        (None, None, True, False),
        (None, 'https', False, False),
        (True, 'http', True, True),
        (False, 'https', True, False),
    ],
)
@pytest.mark.parametrize('clear', [False, True])
def test_cookie_transport_through_trusted_proxy(monkeypatch, cookie_secure, proto, trusted, expected, clear) -> None:
    monkeypatch.setattr(settings, 'COOKIE_SECURE', cookie_secure)

    def cookies(request: Request) -> Response:
        response = Response()
        if clear:
            clear_refresh_cookie(response, request)
            clear_state_cookie(response, request)
        else:
            set_refresh_cookie(response, request, 'session.secret', int(time.time()) + 3600)
            set_state_cookie(response, request, 'oauth-state')
        return response

    app = ProxyHeadersMiddleware(
        Starlette(routes=[Route('/cookies', cookies)]), trusted_hosts=['testclient'] if trusted else []
    )
    with TestClient(app) as client:
        response = client.get('/cookies', headers={} if proto is None else {'X-Forwarded-Proto': proto})

    assert response.status_code == 200
    # 第一行是实际 refresh cookie；后面还有一行同名的旧 Path=/ 删除头。
    for name, index, path, value in [
        (settings.COOKIE_REFRESH_TOKEN_KEY, 0, settings.COOKIE_REFRESH_TOKEN_PATH, 'session.secret'),
        (STATE_COOKIE_KEY, 2, f'{settings.FASTAPI_API_V1_PATH}/oauth2', 'oauth-state'),
    ]:
        cookie = SimpleCookie(response.headers.get_list('set-cookie')[index])[name]
        assert bool(cookie['secure']) is expected
        assert cookie['httponly']
        assert cookie['samesite'] == 'lax'
        assert cookie['path'] == path
        assert cookie.value == ('' if clear else value)
