"""#304：被拒绝或发送失败的重发不能破坏上一条已送达的验证码。"""

from __future__ import annotations

import asyncio
import functools

from typing import TYPE_CHECKING, Any

import pytest

from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.sms.enums import CIRCUIT_OPEN
from backend.plugin.sms.errors import SmsSendError
from backend.plugin.sms.sdk.base import SmsErrorKind, SmsMessage, SmsResult
from backend.plugin.sms.sdk.console import ConsoleSmsProvider
from backend.plugin.sms.service.captcha_service import captcha_key, sms_captcha_service
from backend.plugin.sms.service.guard import cooldown_key, global_hourly_key, phone_daily_key
from backend.plugin.sms.tests.conftest import PHONE_A

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from starlette.testclient import TestClient


@pytest.fixture(autouse=True)
def _captcha_env(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    codes = iter(('123456', '654321', '234567', '345678', '456789', '567890'))
    monkeypatch.setattr('backend.plugin.sms.service.captcha_service.generate_code', lambda: next(codes))

    async def clear() -> None:
        keys = await redis_client.keys(f'{settings.SMS_REDIS_PREFIX}:*')
        if keys:
            await redis_client.delete(*keys)

    client.portal.call(clear)
    yield
    client.portal.call(clear)


def _send(client: TestClient, scene: str = 'bind') -> None:
    client.portal.call(
        functools.partial(sms_captcha_service.send, scene=scene, subject=PHONE_A, phone=PHONE_A, user_id=None)
    )


def _verify(client: TestClient, code: str, scene: str = 'bind') -> str:
    return client.portal.call(
        functools.partial(sms_captcha_service.verify, scene=scene, subject=PHONE_A, phone=PHONE_A, code=code)
    )


def _old_code(client: TestClient, scene: str = 'bind') -> tuple[str, int, int]:
    _send(client, scene)
    key = captcha_key(scene, PHONE_A, PHONE_A)
    assert _verify(client, '000000', scene) == 'wrong'
    # 缩短旧码剩余寿命：重发失败不能偷偷给它续满有效期。
    client.portal.call(redis_client.pexpire, key, 60_000)
    client.portal.call(redis_client.pexpire, f'{key}:attempts', 60_000)
    return key, client.portal.call(redis_client.pttl, key), client.portal.call(redis_client.pttl, f'{key}:attempts')


def _assert_old_code(client: TestClient, key: str, ttl: int, attempts_ttl: int, scene: str = 'bind') -> None:
    assert client.portal.call(redis_client.get, key) == '123456'
    assert client.portal.call(redis_client.get, f'{key}:attempts') == '1'
    assert 0 < client.portal.call(redis_client.pttl, key) <= ttl
    assert 0 < client.portal.call(redis_client.pttl, f'{key}:attempts') <= attempts_ttl
    assert _verify(client, '123456', scene) == 'ok'
    assert _verify(client, '123456', scene) == 'expired'


@pytest.mark.parametrize('scene', ['bind', 'login'])
@pytest.mark.parametrize('limit', ['cooldown', 'daily', 'circuit'])
def test_limited_resend_keeps_delivered_code_and_attempts(
    client: TestClient,
    make_config: Callable[..., dict[str, Any]],
    scene: str,
    limit: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_config('captcha-limit', is_default=True)
    key, ttl, attempts_ttl = _old_code(client, scene)
    if limit != 'cooldown':
        client.portal.call(redis_client.delete, cooldown_key('captcha', PHONE_A))
    if limit == 'daily':
        client.portal.call(functools.partial(redis_client.set, phone_daily_key('captcha', PHONE_A), '10', ex=3600))
    elif limit == 'circuit':
        monkeypatch.setattr(settings, 'SMS_GLOBAL_HOURLY_MAX', 1)
        client.portal.call(functools.partial(redis_client.set, global_hourly_key(), '1', ex=3600))
    with pytest.raises(SmsSendError) as info:
        _send(client, scene)
    assert info.value.kind == (CIRCUIT_OPEN if limit == 'circuit' else 'rate_limited')
    _assert_old_code(client, key, ttl, attempts_ttl, scene)


@pytest.mark.parametrize('kind', [SmsErrorKind.config_error, SmsErrorKind.provider_error, SmsErrorKind.unknown])
def test_failed_resend_preserves_old_code(
    client: TestClient,
    make_config: Callable[..., dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
    kind: SmsErrorKind,
) -> None:
    make_config('captcha-failed', is_default=True)
    key, ttl, attempts_ttl = _old_code(client)
    client.portal.call(redis_client.delete, cooldown_key('captcha', PHONE_A))

    async def fail(_self: ConsoleSmsProvider, _msg: SmsMessage) -> SmsResult:  # ruff: ignore[unused-async]
        return SmsResult.failed(kind, provider_code='RESEND_FAILED', provider_msg='test resend failure')

    monkeypatch.setattr(ConsoleSmsProvider, '_send', fail)
    with pytest.raises(SmsSendError) as info:
        _send(client)
    assert info.value.kind == kind.value
    _assert_old_code(client, key, ttl, attempts_ttl)


def test_successful_resend_replaces_code_and_resets_attempts(
    client: TestClient,
    make_config: Callable[..., dict[str, Any]],
) -> None:
    make_config('captcha-replace', is_default=True)
    key, _, _ = _old_code(client)
    client.portal.call(redis_client.delete, cooldown_key('captcha', PHONE_A))
    _send(client)
    assert client.portal.call(redis_client.get, key) == '654321'
    assert client.portal.call(redis_client.get, f'{key}:attempts') is None
    assert 60_000 < client.portal.call(redis_client.pttl, key) <= settings.SMS_CAPTCHA_EXPIRE_SECONDS * 1000
    assert _verify(client, '123456') == 'wrong'
    assert _verify(client, '654321') == 'ok'


def test_concurrent_rejections_cannot_delete_successful_code(
    client: TestClient,
    make_config: Callable[..., dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_config('captcha-concurrent', is_default=True)
    sent: list[str] = []
    original_send = ConsoleSmsProvider._send

    async def capture(provider: ConsoleSmsProvider, msg: SmsMessage) -> SmsResult:
        sent.append(dict(msg.params)['code'])
        return await original_send(provider, msg)

    monkeypatch.setattr(ConsoleSmsProvider, '_send', capture)

    async def race() -> list[Any]:
        await asyncio.gather(*(redis_client.ping() for _ in range(6)))
        return await asyncio.gather(
            *(sms_captcha_service.send(scene='bind', subject=PHONE_A, phone=PHONE_A, user_id=None) for _ in range(5)),
            return_exceptions=True,
        )

    outcomes = client.portal.call(race)
    assert sum(o is None for o in outcomes) == 1, outcomes
    assert sum(isinstance(o, SmsSendError) and o.kind == 'rate_limited' for o in outcomes) == 4, outcomes
    assert len(sent) == 1
    assert _verify(client, sent[0]) == 'ok'


def test_pending_resend_keeps_old_code_until_provider_accepts(
    client: TestClient,
    make_config: Callable[..., dict[str, Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    make_config('captcha-pending', is_default=True)
    key, _, _ = _old_code(client)
    client.portal.call(redis_client.delete, cooldown_key('captcha', PHONE_A))
    original_send = ConsoleSmsProvider._send

    async def run() -> None:
        started, release = asyncio.Event(), asyncio.Event()

        async def hold(provider: ConsoleSmsProvider, msg: SmsMessage) -> SmsResult:
            started.set()
            await release.wait()
            return await original_send(provider, msg)

        monkeypatch.setattr(ConsoleSmsProvider, '_send', hold)
        pending = asyncio.create_task(
            sms_captcha_service.send(scene='bind', subject=PHONE_A, phone=PHONE_A, user_id=None)
        )
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            assert await redis_client.get(key) == '123456'
            assert await redis_client.get(f'{key}:attempts') == '1'
        finally:
            release.set()
            await pending
        assert await redis_client.get(key) == '654321'
        assert await redis_client.get(f'{key}:attempts') is None

    client.portal.call(run)
