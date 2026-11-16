"""二次验证（#181）：真实 `/auth/login` + 测试库 + 真实 Redis。

要守的都是「写错了不报错」的那一类：

- 开了 MFA，登录照样一步就进来了（某条登录路径漏了 gate）
- 同一个动态码能用两次 / 恢复码能用两次
- 有密码的人能无限试动态码（密码一对就把失败计数清零）
- 被强制的人能自己关掉 / 没配密钥也能改成强制（改完谁都登不进来）
- 动态码、恢复码、绑定密钥原样落进操作日志

回归覆盖：同一挑战 32 个并发错码最多只有 5 个进入校验；并发正确码只消费成功一次；账号并发失败计数不丢，
锁定事件只记一次。
"""

import asyncio
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
            await db.execute(
                text("DELETE FROM sys_data_change WHERE entity_type = 'user' AND entity_id = :pk"), {'pk': pk}
            )
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

    @pytest.mark.parametrize('setup', [False, True])
    def test_concurrent_challenge_attempts_are_reserved_before_code_check(
        self, client: TestClient, user_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, *, setup: bool
    ) -> None:
        """真实数据库和 Redis：验证 / 首次绑定两条路径都只能校验五次。"""
        import json

        from backend.app.admin.service import mfa_service
        from backend.common.exception import errors

        if setup:
            settings.LOGIN_MFA_ENFORCE = 'all'
        else:
            _enable(client, user_headers)
        token = _login(client).json()['data']['mfa_token']
        key = mfa_service._key('challenge', token)
        if setup:
            assert client.post('/auth/mfa/setup', json={'mfa_token': token}).json()['code'] == 200
        checks = 0
        arrivals = 0
        all_arrived = asyncio.Event()
        original_load = mfa_service._load
        original_check = totp.verify if setup else mfa_service._check_code

        async def load_together(value: str) -> dict[str, Any]:
            nonlocal arrivals
            payload = await original_load(value)
            arrivals += 1
            if arrivals == 32:
                all_arrived.set()
            await all_arrived.wait()
            return payload

        def count_check(*args: Any, **kwargs: Any) -> Any:
            nonlocal checks
            checks += 1
            return original_check(*args, **kwargs)

        monkeypatch.setattr(mfa_service, '_load', load_together)
        monkeypatch.setattr(totp if setup else mfa_service, 'verify' if setup else '_check_code', count_check)

        async def race() -> list[object]:
            async def attempt() -> object:
                async with async_test_db_session.begin() as db:
                    if setup:
                        return await mfa_service.challenge_enroll(db, token, 'invalid-recovery-code')
                    return await mfa_service.verify_challenge(db, token, 'invalid-recovery-code')

            return await asyncio.wait_for(asyncio.gather(*(attempt() for _ in range(32)), return_exceptions=True), 15)

        # Capture the actual user before the token is invalidated by the fifth failure.
        raw = client.portal.call(redis_client.get, key)
        user_id = json.loads(raw)['user_id']
        results = client.portal.call(race)
        assert checks == settings.MFA_CHALLENGE_ATTEMPTS
        assert all(isinstance(result, errors.AuthorizationError) for result in results), results
        for kind in ('challenge', 'attempts', 'failures', 'pending'):
            assert client.portal.call(redis_client.exists, mfa_service._key(kind, token)) == 0
        assert client.portal.call(redis_client.exists, mfa_service._key('setup', f'login:{token}')) == 0
        assert client.portal.call(redis_client.get, f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}') == '5'

    def test_concurrent_valid_challenge_is_consumed_only_once(
        self, client: TestClient, user_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """真实会话并发校验同一个恢复码：挑战只成功一次，其他事务回滚。"""
        from backend.app.admin.service import mfa_service
        from backend.common.exception import errors

        _, codes = _enable(client, user_headers)
        token = _login(client).json()['data']['mfa_token']
        checks = 0
        arrivals = 0
        all_arrived = asyncio.Event()
        consume_arrivals = 0
        all_ready_to_consume = asyncio.Event()
        # 每个请求持有真实连接；低于共享连接池上限，避免屏障自己耗尽连接池。
        concurrency = 24
        original_row = mfa_service._row
        original_check = mfa_service._check_code
        original_eval = redis_client.eval

        async def rows_together(db: Any, user_id: int) -> Any:
            nonlocal arrivals
            row = await original_row(db, user_id)
            arrivals += 1
            if arrivals == concurrency:
                all_arrived.set()
            await all_arrived.wait()
            return row

        def count_check(row: Any, otp: str) -> bool:
            nonlocal checks
            checks += 1
            return original_check(row, otp)

        async def gate_consumption(script: str, numkeys: int, *keys_and_args: Any) -> Any:
            nonlocal consume_arrivals
            if script == mfa_service._CONSUME_CHALLENGE:
                consume_arrivals += 1
                if consume_arrivals == settings.MFA_CHALLENGE_ATTEMPTS:
                    all_ready_to_consume.set()
                await all_ready_to_consume.wait()
            return await original_eval(script, numkeys, *keys_and_args)

        monkeypatch.setattr(mfa_service, '_row', rows_together)
        monkeypatch.setattr(mfa_service, '_check_code', count_check)
        monkeypatch.setattr(redis_client, 'eval', gate_consumption)

        async def race() -> list[object]:
            async def attempt() -> object:
                async with async_test_db_session.begin() as db:
                    return await mfa_service.verify_challenge(db, token, codes[0])

            return await asyncio.wait_for(
                asyncio.gather(*(attempt() for _ in range(concurrency)), return_exceptions=True), 15
            )

        results = client.portal.call(race)
        assert checks == settings.MFA_CHALLENGE_ATTEMPTS
        assert consume_arrivals == settings.MFA_CHALLENGE_ATTEMPTS
        assert sum(isinstance(result, dict) for result in results) == 1, results
        assert sum(isinstance(result, errors.AuthorizationError) for result in results) == concurrency - 1, results
        for kind in ('challenge', 'attempts', 'failures', 'pending'):
            assert client.portal.call(redis_client.exists, mfa_service._key(kind, token)) == 0
        assert client.get(MFA, headers=user_headers).json()['data']['recovery_remaining'] == 9

    def test_concurrent_account_failures_keep_count_and_lock_once(
        self, client: TestClient, user_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """真实会话和 Redis：32 次失败完整累加，只持久化一次锁定事件。"""
        from backend.app.admin.service import user_password_history_service as security
        from backend.common.exception import errors

        user_id = int(client.get('/sys/users/me', headers=user_headers).json()['data']['id'])
        counter_key = f'{settings.LOGIN_FAILURE_PREFIX}:{user_id}'
        lock_key = f'{settings.USER_LOCK_REDIS_PREFIX}:{user_id}'
        monkeypatch.setattr(settings, 'USER_LOCK_THRESHOLD', 12)
        arrivals = 0
        all_arrived = asyncio.Event()

        async def config_barrier(_db: Any) -> None:
            nonlocal arrivals
            arrivals += 1
            if arrivals == 32:
                all_arrived.set()
            await all_arrived.wait()

        monkeypatch.setattr(security, 'load_user_security_config', config_barrier)

        async def lock_events() -> int:
            async with async_test_db_session() as db:
                return await db.scalar(
                    text("SELECT COUNT(*) FROM sys_login_log WHERE username=:name AND event='locked'"),
                    {'name': USERNAME},
                )

        before = client.portal.call(lock_events)

        async def race() -> list[object]:
            async def attempt() -> None:
                async with async_test_db_session.begin() as db:
                    await security.password_security_service.handle_login_failure(db, user_id)

            return await asyncio.wait_for(asyncio.gather(*(attempt() for _ in range(32)), return_exceptions=True), 15)

        results = client.portal.call(race)
        assert client.portal.call(redis_client.get, counter_key) == '32'
        assert 0 < client.portal.call(redis_client.ttl, counter_key) <= settings.USER_LOCK_SECONDS
        assert 0 < client.portal.call(redis_client.ttl, lock_key) <= settings.USER_LOCK_SECONDS
        assert client.portal.call(lock_events) == before + 1
        assert sum(result is None for result in results) == 11
        assert sum(isinstance(result, errors.AuthorizationError) for result in results) == 21, results

    def test_last_reserved_valid_attempt_survives_other_failures(
        self, client: TestClient, user_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """五个名额同时获准：四个失败先完成，不能删掉第五个正确请求的挑战。"""
        from backend.app.admin.service import mfa_service
        from backend.common.exception import errors

        _, codes = _enable(client, user_headers)
        token = _login(client).json()['data']['mfa_token']
        limit = settings.MFA_CHALLENGE_ATTEMPTS
        reserved = 0
        finished = 0
        all_reserved = asyncio.Event()
        failures_finished = asyncio.Event()
        observed_ttls: dict[str, int] = {}
        original_reserve = mfa_service._reserve_attempt
        original_eval = redis_client.eval

        async def reserve_together(value: str) -> int:
            nonlocal reserved
            result = await original_reserve(value)
            reserved += 1
            if reserved == limit:
                observed_ttls['challenge'] = await redis_client.pttl(mfa_service._key('challenge', token))
                observed_ttls['attempts'] = await redis_client.pttl(mfa_service._key('attempts', token))
                observed_ttls['pending'] = await redis_client.pttl(mfa_service._key('pending', token))
                all_reserved.set()
            await all_reserved.wait()
            return result

        async def failures_before_success(script: str, numkeys: int, *args: Any) -> Any:
            nonlocal finished
            if script == mfa_service._CONSUME_CHALLENGE:
                await failures_finished.wait()
                observed_ttls['failures'] = await redis_client.pttl(mfa_service._key('failures', token))
            result = await original_eval(script, numkeys, *args)
            if script == mfa_service._FINISH_CHALLENGE_ATTEMPT:
                finished += 1
                if finished == limit - 1:
                    failures_finished.set()
            return result

        monkeypatch.setattr(mfa_service, '_reserve_attempt', reserve_together)
        monkeypatch.setattr(redis_client, 'eval', failures_before_success)

        async def race() -> list[object]:
            async def attempt(otp: str) -> object:
                async with async_test_db_session.begin() as db:
                    return await mfa_service.verify_challenge(db, token, otp)

            return await asyncio.wait_for(
                asyncio.gather(
                    *(attempt('invalid-recovery-code') for _ in range(limit - 1)),
                    attempt(codes[0]),
                    return_exceptions=True,
                ),
                15,
            )

        results = client.portal.call(race)
        assert all(isinstance(result, errors.AuthorizationError) for result in results[:-1]), results
        assert isinstance(results[-1], dict), results
        assert 0 < min(observed_ttls.values()) <= max(observed_ttls.values()) <= settings.MFA_CHALLENGE_SECONDS * 1000
        assert set(observed_ttls) == {'challenge', 'attempts', 'pending', 'failures'}
        assert client.get(MFA, headers=user_headers).json()['data']['recovery_remaining'] == 9
        for kind in ('challenge', 'attempts', 'failures', 'pending'):
            assert client.portal.call(redis_client.exists, mfa_service._key(kind, token)) == 0

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


def _mfa_records(client: TestClient, token_headers: dict[str, str], uid: str) -> list[dict[str, Any]]:
    """这个人名下和二次验证有关的数据变更记录，旧的在前"""
    res = client.get(
        '/logs/changes', headers=token_headers, params={'entity_type': 'user', 'entity_id': uid, 'size': 50}
    ).json()
    assert res['code'] == 200, res
    return [r for r in reversed(res['data']['items']) if any(c['field'].startswith('mfa') for c in r['changes'])]


_ON = {'field': 'mfa', 'label': '二次验证', 'old': False, 'new': True, 'old_label': '未开启', 'new_label': '已开启'}
_OFF = {'field': 'mfa', 'label': '二次验证', 'old': True, 'new': False, 'old_label': '已开启', 'new_label': '未开启'}


class TestChangeRecords:
    """数据变更审计（#260 二期）：二次验证的开关记在**用户**名下 —— 「谁把他的二次验证关了」在用户的变更记录里看得到"""

    def test_enable_regenerate_and_admin_reset(
        self, client: TestClient, token_headers: dict[str, str], user_headers: dict[str, str]
    ) -> None:
        uid = client.get('/sys/users/me', headers=user_headers).json()['data']['id']
        secret, codes = _enable(client, user_headers)
        (on,) = _mfa_records(client, token_headers, uid)
        assert on['action'] == 'update' and on['actor_name'] == USERNAME and on['source'] == 'web'
        assert on['changes'] == [_ON], '开启时只记开关，不另记「生成了恢复码」'

        # 用动态码登录写 last_step：不是改设置，不出记录
        token = _login(client).json()['data']['mfa_token']
        ok = client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': _code(secret, 1)}).json()
        assert ok['code'] == 200, ok
        fresh = {'Authorization': f'Bearer {ok["data"]["access_token"]}'}
        assert len(_mfa_records(client, token_headers, uid)) == 1

        # 重新生成恢复码（拿旧的一个恢复码当凭据）：只记「改过」，哈希一个字都不进审计表
        regen = client.post(f'{MFA}/recovery-codes', headers=fresh, json={'otp': codes[0]}).json()
        assert regen['code'] == 200, regen
        _, renewed = _mfa_records(client, token_headers, uid)
        assert renewed['actor_name'] == USERNAME
        assert renewed['changes'] == [{'field': 'mfa_recovery_codes', 'label': '恢复码', 'secret': True}]

        # 用新的恢复码登录：只是标上「用过」，不算改
        token = _login(client).json()['data']['mfa_token']
        new_code = regen['data']['recovery_codes'][0]
        assert client.post('/auth/mfa/verify', json={'mfa_token': token, 'otp': new_code}).json()['code'] == 200
        assert len(_mfa_records(client, token_headers, uid)) == 2

        # 管理员重置：记在这个人名下，操作人是管理员
        assert client.delete(f'/sys/users/{uid}/mfa', headers=token_headers).json()['code'] == 200
        *_, reset = _mfa_records(client, token_headers, uid)
        assert reset['actor_name'] == 'admin' and reset['changes'] == [_OFF]

    def test_turning_it_off_yourself(
        self, client: TestClient, token_headers: dict[str, str], user_headers: dict[str, str]
    ) -> None:
        uid = client.get('/sys/users/me', headers=user_headers).json()['data']['id']
        secret, _ = _enable(client, user_headers)
        assert client.post(f'{MFA}/disable', headers=user_headers, json={'otp': _code(secret, 1)}).json()['code'] == 200
        _, off = _mfa_records(client, token_headers, uid)
        assert off['actor_name'] == USERNAME and off['changes'] == [_OFF]

    def test_enrolling_during_login_is_recorded_as_the_user(
        self, client: TestClient, token_headers: dict[str, str], user_headers: dict[str, str]
    ) -> None:
        """登录还没完成，请求里没有操作人 —— 不显式给的话记成「系统」开的"""
        uid = client.get('/sys/users/me', headers=user_headers).json()['data']['id']
        settings.LOGIN_MFA_ENFORCE = 'all'
        first = _login(client).json()['data']
        setup = client.post('/auth/mfa/setup', json={'mfa_token': first['mfa_token']}).json()['data']
        done = client.post(
            '/auth/mfa/enroll', json={'mfa_token': first['mfa_token'], 'otp': _code(setup['totp_secret'])}
        ).json()
        assert done['code'] == 200, done
        (on,) = _mfa_records(client, token_headers, uid)
        assert on['actor_name'] == USERNAME and on['actor_id'] == uid and on['source'] == 'web'
        assert on['changes'] == [_ON]
