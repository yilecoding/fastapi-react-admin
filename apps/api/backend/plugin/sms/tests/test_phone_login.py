"""手机验证码登录（issue #168 第二步）：两个匿名接口 `/auth/phone/captcha` · `/auth/phone/login`。

守的是「不能泄漏什么」多过「能不能登」：

- 没注册 / 注册了但没经本人验证 / 验证过 —— 发码接口对三种号的状态码、文案、冷却一致，只有第三种真发
- 登录接口对「没注册」「码错」「码过期」一句话、一个状态码
- 只认 `phone_verified_time` 非空的号：管理员录的号登不了

路由在 `app/admin`，测试放这里是因为整条链压在短信插件上（`make_config` 建控制台配置）。
用 admin 自己：直接写库给它一个号 + 验证时间，收尾还原成 NULL
（conftest 的 `token_headers` 是 admin 的，别把它留成带号的）。
"""

from __future__ import annotations

import time

from typing import TYPE_CHECKING, Any

import pytest

from sqlalchemy import text

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import redis_client
from backend.plugin.sms.service.captcha_service import captcha_key
from backend.plugin.sms.tests.conftest import PHONE_A, PHONE_B, PHONE_C, run_sync

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from starlette.testclient import TestClient

CAPTCHA = '/auth/phone/captcha'
LOGIN = '/auth/phone/login'
#: 库里没有这个号
UNKNOWN = PHONE_C


def _set_admin_phone(phone: str | None, *, verified: bool) -> None:
    async def _do() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as db:
                stmt = (
                    'UPDATE sys_user SET phone = :phone, phone_verified_time = '
                    + ('CURRENT_TIMESTAMP' if verified else 'NULL')
                    + " WHERE username = 'admin'"
                )
                await db.execute(text(stmt), {'phone': phone})
        finally:
            await engine.dispose()

    run_sync(_do())


@pytest.fixture(autouse=True)
def _clean(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """图形验证码关掉（同 admin tests 的 `no_captcha`：连 `load_login_config` 一起顶掉，否则 sys_config 会把值写回来）；
    清掉发码冷却 / 登录失败计数 / 短信防刷键；admin 的号还原成 NULL"""

    async def _noop(_db: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async，签名要对上
        return None

    monkeypatch.setattr('backend.app.admin.service.auth_service.load_login_config', _noop)
    monkeypatch.setattr(settings, 'LOGIN_CAPTCHA_ENABLED', False)

    async def _flush() -> None:
        for prefix in (
            f'{settings.LOGIN_CAPTCHA_REDIS_PREFIX}:phone',
            settings.SMS_REDIS_PREFIX,
            settings.LOGIN_FAILURE_PREFIX,
            settings.USER_LOCK_REDIS_PREFIX,
            settings.LOGIN_IP_FAILURE_PREFIX,
        ):
            keys = await redis_client.keys(f'{prefix}*')
            if keys:
                await redis_client.delete(*keys)
        # admin 的用户缓存：改了库里的号要让 /users/me 看到
        keys = await redis_client.keys(f'{settings.JWT_USER_REDIS_PREFIX}:*')
        if keys:
            await redis_client.delete(*keys)

    client.portal.call(_flush)
    yield
    _set_admin_phone(None, verified=False)
    client.portal.call(_flush)


def _login_code(client: TestClient, phone: str) -> str | None:
    return client.portal.call(redis_client.get, captcha_key('login', phone, phone))


class TestSendCaptcha:
    def test_unknown_and_unverified_numbers_look_sent_but_nothing_goes_out(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('login', is_default=True)
        # 没注册
        started = time.perf_counter()
        res = client.post(CAPTCHA, json={'phone': UNKNOWN})
        elapsed = time.perf_counter() - started
        assert res.json()['code'] == 200, res.text
        assert _login_code(client, UNKNOWN) is None, '没注册的号不能真发、也不能留码'
        assert elapsed >= 0.25, f'不发的那条要补齐耗时（{elapsed * 1000:.0f}ms），否则响应时长就是「有没有账号」'
        # 注册了但管理员录的、没验证
        _set_admin_phone(PHONE_A, verified=False)
        assert client.post(CAPTCHA, json={'phone': PHONE_A}).json()['code'] == 200
        assert _login_code(client, PHONE_A) is None, '没经本人验证的号不能用来登录，自然也不发码'
        # 两种号第二次都是「太频繁」—— 冷却对没注册的号也要生效，否则 400 / 200 就把注册状态说出去了
        again_unknown = client.post(CAPTCHA, json={'phone': UNKNOWN})
        again_unverified = client.post(CAPTCHA, json={'phone': PHONE_A})
        assert again_unknown.status_code == again_unverified.status_code == 400
        assert again_unknown.json()['msg'] == again_unverified.json()['msg']

    def test_verified_number_gets_a_code_and_the_same_cooldown(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('login2', is_default=True)
        _set_admin_phone(PHONE_B, verified=True)
        assert client.post(CAPTCHA, json={'phone': PHONE_B}).json()['code'] == 200
        code = _login_code(client, PHONE_B)
        assert code is not None and len(code) == 6
        again = client.post(CAPTCHA, json={'phone': PHONE_B})
        unknown_again = client.post(CAPTCHA, json={'phone': UNKNOWN})
        unknown_again = client.post(CAPTCHA, json={'phone': UNKNOWN})
        assert again.status_code == unknown_again.status_code == 400
        assert again.json()['msg'] == unknown_again.json()['msg']

    def test_graphical_captcha_is_required_when_enabled(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        """图形验证码开着时不带就是 400 —— 否则这个匿名接口就是免费的短信轰炸入口"""
        make_config('login3', is_default=True)
        monkeypatch.setattr(settings, 'LOGIN_CAPTCHA_ENABLED', True)
        _set_admin_phone(PHONE_B, verified=True)
        res = client.post(CAPTCHA, json={'phone': PHONE_B})
        assert res.status_code == 400, res.text
        assert _login_code(client, PHONE_B) is None

    def test_provider_failure_looks_exactly_like_an_unknown_number(self, client: TestClient) -> None:
        """短信通道没配好（一个可用配置都没有）：验证过的号也是 200、Redis 里没码、第二次同样「太频繁」。
        厂商侧失败只会发生在验证过的号上 —— 原样抛 400 / 502，故障期间这个接口就是号码核对器"""
        _set_admin_phone(PHONE_B, verified=True)
        real = client.post(CAPTCHA, json={'phone': PHONE_B})
        unknown = client.post(CAPTCHA, json={'phone': UNKNOWN})
        assert real.status_code == unknown.status_code == 200, real.text
        assert real.json()['msg'] == unknown.json()['msg']
        assert _login_code(client, PHONE_B) is None, '没发出去的码不能留着'
        # 冷却也不退：退了就是「验证过的号能立刻再试、别的号要等 60 秒」
        real_again = client.post(CAPTCHA, json={'phone': PHONE_B})
        unknown_again = client.post(CAPTCHA, json={'phone': UNKNOWN})
        assert real_again.status_code == unknown_again.status_code == 400
        assert real_again.json()['msg'] == unknown_again.json()['msg']


class TestLogin:
    def test_wrong_code_unknown_number_and_unverified_number_are_indistinguishable(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('login4', is_default=True)
        _set_admin_phone(PHONE_B, verified=True)
        assert client.post(CAPTCHA, json={'phone': PHONE_B}).json()['code'] == 200
        wrong = client.post(LOGIN, json={'phone': PHONE_B, 'captcha': '000000'})
        unknown = client.post(LOGIN, json={'phone': UNKNOWN, 'captcha': '000000'})
        assert wrong.status_code == unknown.status_code == 403
        assert wrong.json()['msg'] == unknown.json()['msg']
        # 管理员录的号：就算码是对的也不认（这个号没经本人验证）
        code = _login_code(client, PHONE_B)
        _set_admin_phone(PHONE_B, verified=False)
        unverified = client.post(LOGIN, json={'phone': PHONE_B, 'captcha': code})
        assert unverified.status_code == 403 and unverified.json()['msg'] == unknown.json()['msg']

    def test_right_code_opens_a_session_once(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('login5', is_default=True)
        _set_admin_phone(PHONE_B, verified=True)
        assert client.post(CAPTCHA, json={'phone': PHONE_B}).json()['code'] == 200
        code = _login_code(client, PHONE_B)
        res = client.post(LOGIN, json={'phone': PHONE_B, 'captcha': code})
        assert res.status_code == 200, res.text
        data = res.json()['data']
        assert data['access_token'] and data['user']['username'] == 'admin'
        assert settings.COOKIE_REFRESH_TOKEN_KEY in res.cookies, '要下发 refresh cookie，和密码登录一样'
        # 拿着这枚 token 真的能用
        me = client.get('/sys/users/me', headers={'Authorization': f'Bearer {data["access_token"]}'})
        assert me.json()['code'] == 200 and me.json()['data']['username'] == 'admin'
        # 码是一次性的
        again = client.post(LOGIN, json={'phone': PHONE_B, 'captcha': code})
        assert again.status_code == 403

    def test_bad_phone_is_422(self, client: TestClient) -> None:
        assert client.post(CAPTCHA, json={'phone': '12345'}).status_code == 422
        assert client.post(LOGIN, json={'phone': '12345', 'captcha': '1'}).status_code == 422
