"""二次验证（#181）：真实 `/auth/login` + 测试库 + 真实 Redis。

要守的都是「写错了不报错」的那一类：

- 开了 MFA，登录照样一步就进来了（某条登录路径漏了 gate）
- 同一个动态码能用两次 / 恢复码能用两次
- 有密码的人能无限试动态码（密码一对就把失败计数清零）
- 被强制的人能自己关掉 / 没配密钥也能改成强制（改完谁都登不进来）
- 动态码、恢复码、绑定密钥原样落进操作日志
"""

import time

from collections.abc import Iterator
from typing import Any

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.middleware.opera_log_middleware import OperaLogMiddleware
from backend.tests.utils.db import async_test_db_session
from backend.utils import totp

USERNAME = 'pytest_mfa'
PASSWORD = 'Tmp@123456'
MFA = '/sys/users/me/mfa'


def _code(secret: str, steps_ahead: int = 0) -> str:
    """当前时间片往后数第几个的码。校验时前后各容忍一片，所以 0 和 1 都能用"""
    return totp.code_at(secret, time.time() + 30 * steps_ahead)


def _login(client: TestClient, password: str = PASSWORD) -> Any:
    return client.post('/auth/login', json={'username': USERNAME, 'password': password})


async def _flush_counters() -> None:
    for prefix in (
        settings.LOGIN_FAILURE_PREFIX,
        settings.USER_LOCK_REDIS_PREFIX,
        settings.LOGIN_IP_FAILURE_PREFIX,
        settings.REQUEST_LIMITER_REDIS_PREFIX,
        settings.MFA_REDIS_PREFIX,
    ):
        keys = await redis_client.keys(f'{prefix}*')
        if keys:
            await redis_client.delete(*keys)


async def _purge_user() -> None:
    async with async_test_db_session.begin() as db:
        ids = list((await db.execute(text('SELECT id FROM sys_user WHERE username = :u'), {'u': USERNAME})).scalars())
        for pk in ids:
            await db.execute(text('DELETE FROM sys_user_mfa WHERE user_id = :pk'), {'pk': pk})
            await db.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': pk})
            await db.execute(text('DELETE FROM sys_user WHERE id = :pk'), {'pk': pk})


@pytest.fixture(autouse=True)
def _env(client: TestClient, no_captcha: None, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """一个临时账号（不拿 admin 练锁定）；MFA 密钥配上；策略默认自愿"""
    monkeypatch.setattr(settings, 'MFA_SECRET_KEY', '00' * 32)
    monkeypatch.setattr(settings, 'LOGIN_MFA_ENFORCE', 'off')
    client.portal.call(_purge_user)
    client.portal.call(_flush_counters)
    yield
    client.portal.call(_purge_user)
    client.portal.call(_flush_counters)


@pytest.fixture
def user_headers(client: TestClient, token_headers: dict[str, str]) -> dict[str, str]:
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']
    body = {'username': USERNAME, 'password': PASSWORD, 'nickname': 'MFA', 'dept_id': dept_id, 'roles': [role_id]}
    assert client.post('/sys/users', headers=token_headers, json=body).json()['code'] == 200
    data = _login(client).json()['data']
    assert 'access_token' in data, '前置：还没开 MFA，一步就能登录'
    return {'Authorization': f'Bearer {data["access_token"]}'}


def _enable(client: TestClient, headers: dict[str, str]) -> tuple[str, list[str]]:
    setup = client.post(f'{MFA}/setup', headers=headers).json()['data']
    secret = setup['totp_secret']
    assert setup['otpauth_uri'].startswith('otpauth://totp/') and f'secret={secret}' in setup['otpauth_uri']
    res = client.post(f'{MFA}/enable', headers=headers, json={'otp': _code(secret)}).json()
    assert res['code'] == 200, res
    return secret, res['data']['recovery_codes']


class TestEnableAndLogin:
    def test_enabled_account_needs_the_second_step(self, client: TestClient, user_headers: dict[str, str]) -> None:
        secret, codes = _enable(client, user_headers)
        assert len(codes) == 10
        status = client.get(MFA, headers=user_headers).json()['data']
        assert status['enabled'] is True and status['recovery_remaining'] == 10

        first = _login(client)
        data = first.json()['data']
        assert data['mfa_required'] is True and data['mfa_setup'] is False
        assert 'access_token' not in data
        assert 'refresh' not in (first.headers.get('set-cookie') or ''), '第一步不能下发 refresh cookie'

        # 开启时用掉了当前这一片，登录用下一片（前后各容忍一片）
        otp = _code(secret, 1)
        second = client.post('/auth/mfa/verify', json={'mfa_token': data['mfa_token'], 'otp': otp})
        assert second.json()['code'] == 200 and second.json()['data']['access_token']
        assert 'refresh' in (second.headers.get('set-cookie') or '')

        # 同一个码不能用第二次（RFC 6238 5.2）—— 换一个新令牌再拿它试
        again = _login(client).json()['data']
        reuse = client.post('/auth/mfa/verify', json={'mfa_token': again['mfa_token'], 'otp': otp}).json()
        assert reuse['code'] == 403

    def test_recovery_code_works_once(self, client: TestClient, user_headers: dict[str, str]) -> None:
        _, codes = _enable(client, user_headers)
        token = _login(client).json()['data']['mfa_token']
        ok = client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': codes[0].upper()}).json()
        assert ok['code'] == 200
        # ⚠️ 同一个 TestClient 共用 cookie：这次登录把 user_headers 那个会话顶掉了（同浏览器重新登录），用新的
        fresh = {'Authorization': f'Bearer {ok["data"]["access_token"]}'}
        token = _login(client).json()['data']['mfa_token']
        assert client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': codes[0]}).json()['code'] == 403
        assert client.get(MFA, headers=fresh).json()['data']['recovery_remaining'] == 9

    def test_password_success_does_not_reset_the_failure_count(
        self, client: TestClient, user_headers: dict[str, str]
    ) -> None:
        """有密码的人：每登一次试几次动态码、登完再登 —— 失败次数要一直累计，满了锁账号"""
        _enable(client, user_headers)
        threshold = settings.USER_LOCK_THRESHOLD
        assert threshold >= 2, '前置：锁定开着'
        for _ in range(threshold - 1):
            token = _login(client).json()['data']['mfa_token']
            assert client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': '000000'}).json()['code'] == 403
        token = _login(client).json()['data']['mfa_token']
        client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': '000000'})
        locked = _login(client).json()
        assert locked['code'] != 200 and 'mfa_token' not in (locked.get('data') or {}), locked

    def test_token_dies_after_too_many_attempts(self, client: TestClient, user_headers: dict[str, str]) -> None:
        secret, _ = _enable(client, user_headers)
        token = _login(client).json()['data']['mfa_token']
        for _ in range(settings.MFA_CHALLENGE_ATTEMPTS):
            client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': '000000'})
        client.portal.call(_flush_counters_except_mfa)
        late = client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': _code(secret, 1)}).json()
        assert late['code'] == 403 and '过期' in late['msg'], late

    def test_swagger_shortcut_is_refused(self, client: TestClient, user_headers: dict[str, str]) -> None:
        _enable(client, user_headers)
        res = client.post('/auth/login/swagger', params={'username': USERNAME, 'password': PASSWORD})
        assert res.status_code == 403 and 'Swagger' in res.json()['msg']


async def _flush_counters_except_mfa() -> None:
    for prefix in (settings.LOGIN_FAILURE_PREFIX, settings.USER_LOCK_REDIS_PREFIX, settings.LOGIN_IP_FAILURE_PREFIX):
        keys = await redis_client.keys(f'{prefix}*')
        if keys:
            await redis_client.delete(*keys)


class TestEnforced:
    def test_enforced_user_enrolls_during_login(self, client: TestClient, user_headers: dict[str, str]) -> None:
        settings.LOGIN_MFA_ENFORCE = 'all'
        first = _login(client).json()['data']
        assert first['mfa_required'] is True and first['mfa_setup'] is True
        # 还没绑定的令牌不能拿来「验证」
        assert (
            client.post('/auth/mfa/verify', json={'mfa_token': first['mfa_token'], 'otp': '123456'}).json()['code']
            == 400
        )
        setup = client.post('/auth/mfa/setup', json={'mfa_token': first['mfa_token']}).json()['data']
        done = client.post(
            '/auth/mfa/enroll', json={'mfa_token': first['mfa_token'], 'otp': _code(setup['totp_secret'])}
        ).json()
        assert done['code'] == 200 and done['data']['access_token'] and len(done['data']['recovery_codes']) == 10
        # 绑完之后再登录：是「验证」不是「绑定」
        assert _login(client).json()['data']['mfa_setup'] is False

    def test_enforced_user_cannot_turn_it_off(self, client: TestClient, user_headers: dict[str, str]) -> None:
        secret, _ = _enable(client, user_headers)
        settings.LOGIN_MFA_ENFORCE = 'all'
        res = client.post(f'{MFA}/disable', headers=user_headers, json={'otp': _code(secret, 1)})
        assert res.status_code == 403
        settings.LOGIN_MFA_ENFORCE = 'off'
        assert client.post(f'{MFA}/disable', headers=user_headers, json={'otp': _code(secret, 1)}).json()['code'] == 200
        assert 'access_token' in _login(client).json()['data'], '关掉之后一步就能登录'

    def test_superuser_mode_leaves_others_alone(self, client: TestClient, user_headers: dict[str, str]) -> None:
        settings.LOGIN_MFA_ENFORCE = 'superuser'
        assert 'access_token' in _login(client).json()['data'], '临时账号不是超管，不该被强制'

    def test_cannot_enforce_without_a_key(self, client: TestClient, token_headers: dict[str, str]) -> None:
        """没密钥还改成强制：被强制的人绑不了，一个都登不进来 —— 包括改它的管理员自己"""
        settings.MFA_SECRET_KEY = ''
        item = _config_row(client, token_headers)
        body = {k: item[k] for k in ('name', 'type', 'key', 'value', 'is_frontend', 'remark')}
        try:
            res = client.put(f'/sys/configs/{item["id"]}', headers=token_headers, json={**body, 'value': 'all'})
            assert res.json()['code'] != 200 and 'MFA_SECRET_KEY' in res.json()['msg']
            res = client.put(f'/sys/configs/{item["id"]}', headers=token_headers, json={**body, 'value': 'sometimes'})
            assert res.json()['code'] != 200
        finally:
            # 🔴 收尾直接改库，不靠接口：变异检验（拿掉这道检查）时上面那句会真的把 all 写进去，
            # 而那时接口恰好又拦不住 —— 留在 fba_test 里，后面每次跑都是「被强制」（实测踩过）
            client.portal.call(_set_enforce, 'off')

    def test_config_list_survives_a_value_that_no_longer_passes(
        self, client: TestClient, token_headers: dict[str, str]
    ) -> None:
        """库里是 all、后来把 MFA_SECRET_KEY 拿掉了：参数配置列表要还能打开（否则连改回去的地方都没有）"""
        client.portal.call(_set_enforce, 'all')
        try:
            settings.MFA_SECRET_KEY = ''
            assert _config_row(client, token_headers)['value'] == 'all'
        finally:
            client.portal.call(_set_enforce, 'off')


def _config_row(client: TestClient, headers: dict[str, str]) -> dict[str, Any]:
    res = client.get('/sys/configs', headers=headers, params={'type': 'LOGIN', 'page': 1, 'size': 50})
    assert res.status_code == 200, res.text
    return next(r for r in res.json()['data']['items'] if r['key'] == 'LOGIN_MFA_ENFORCE')


async def _set_enforce(value: str) -> None:
    from sqlalchemy import update

    from backend.plugin.config.model import Config

    # 走 Core 不写 text()：`key` 是保留字，三个方言的引号写法不一样
    async with async_test_db_session.begin() as db:
        await db.execute(update(Config).where(Config.key == 'LOGIN_MFA_ENFORCE').values(value=value))
    # 参数配置的读取挂着 Redis 缓存（config_service 的 @cached）：直接改库要顺手清，否则读到的是旧值
    keys = await redis_client.keys(f'{settings.CACHE_CONFIG_REDIS_PREFIX}*')
    if keys:
        await redis_client.delete(*keys)


class TestAdminAndSecrets:
    def test_admin_reset(self, client: TestClient, token_headers: dict[str, str], user_headers: dict[str, str]) -> None:
        _enable(client, user_headers)
        assert 'mfa_token' in _login(client).json()['data']
        uid = client.get('/sys/users/me', headers=user_headers).json()['data']['id']
        assert client.delete(f'/sys/users/{uid}/mfa', headers=token_headers).json()['code'] == 200
        assert 'access_token' in _login(client).json()['data']
        # 本来就没开：说清楚，别报「重置成功」
        assert client.delete(f'/sys/users/{uid}/mfa', headers=token_headers).json()['code'] != 200

    def test_setup_without_key_says_so(self, client: TestClient, user_headers: dict[str, str]) -> None:
        settings.MFA_SECRET_KEY = ''
        res = client.post(f'{MFA}/setup', headers=user_headers).json()
        assert res['code'] != 200 and 'MFA_SECRET_KEY' in res['msg']
        assert client.get(MFA, headers=user_headers).json()['data']['available'] is False

    def test_opera_log_redacts_codes_and_secrets(self, client: TestClient, user_headers: dict[str, str]) -> None:
        setup = client.post(f'{MFA}/setup', headers=user_headers)
        secret = setup.json()['data']['totp_secret']
        logged = OperaLogMiddleware.redact_body(setup.content, 'application/json').decode()
        assert USERNAME in setup.text and secret not in logged
        enabled = client.post(f'{MFA}/enable', headers=user_headers, json={'otp': _code(secret)})
        codes = enabled.json()['data']['recovery_codes']
        logged = OperaLogMiddleware.redact_body(enabled.content, 'application/json').decode()
        assert codes and not any(c in logged for c in codes)
        assert OperaLogMiddleware.desensitization({'otp': '123456', 'mfa_token': 'x' * 20}) == {
            'otp': '[REDACTED]',
            'mfa_token': '[REDACTED]',
        }
