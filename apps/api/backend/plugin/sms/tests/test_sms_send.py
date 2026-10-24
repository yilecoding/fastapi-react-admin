"""发送链路（真实 Redis + 测试库）：日志两段式、冷却 / 日上限 / 熔断、选配置、并发。

`sms_service.send()` 不经过 HTTP，所以经 `client.portal.call` 在应用自己的事件循环里调（同 `test_session.py`）——
直接 `asyncio.run()` 会关掉共享 `redis_client` 绑的循环（tests 分册）。
"""

from __future__ import annotations

import asyncio
import functools
import json

from typing import TYPE_CHECKING, Any

import pytest

from sqlalchemy import select

from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import redis_client
from backend.plugin.sms.enums import CIRCUIT_OPEN, SmsLogStatus
from backend.plugin.sms.errors import SmsSendError
from backend.plugin.sms.model import SmsLog
from backend.plugin.sms.sdk.base import SmsErrorKind, SmsMessage, SmsProvider, SmsResult, TemplateMapping
from backend.plugin.sms.sdk.console import ConsoleConfig
from backend.plugin.sms.sdk.registry import register_provider, unregister_provider
from backend.plugin.sms.service.guard import cooldown_key, sms_guard
from backend.plugin.sms.service.sms_service import sms_service
from backend.plugin.sms.templates import get_sms_template, register_sms_template
from backend.plugin.sms.tests.conftest import PHONE_A, PHONE_B, PHONE_C, run_sync

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

    from starlette.testclient import TestClient

#: 冷却 0、日上限 2：给「不想被冷却干扰」的用例用
register_sms_template(
    'pytest_free', label='测试·无冷却', params=('x',), sensitive=(), cooldown_seconds=0, daily_max_per_phone=2
)
#: 没有任何配置映射它
register_sms_template(
    'pytest_orphan', label='测试·无配置', params=('x',), sensitive=(), cooldown_seconds=0, daily_max_per_phone=0
)


def _send(client: TestClient, **kwargs: Any) -> Any:
    return client.portal.call(functools.partial(sms_service.send, **kwargs))


def _expect_error(client: TestClient, kind: str, **kwargs: Any) -> SmsSendError:
    with pytest.raises(SmsSendError) as info:
        _send(client, **kwargs)
    assert info.value.kind == kind, (info.value.kind, info.value.msg)
    return info.value


async def _rows(phone: str) -> list[SmsLog]:
    """用**另一个**会话读日志 —— 这正是「失败日志必须在」要证明的事"""
    engine = create_database_async_engine(get_database_url(unittest=True))
    try:
        async with create_database_async_session(engine)() as db:
            return list(
                (await db.execute(select(SmsLog).where(SmsLog.phone == phone).order_by(SmsLog.id))).scalars().all()
            )
    finally:
        await engine.dispose()


@pytest.fixture(autouse=True)
def _clear_redis(client: TestClient) -> Iterator[None]:
    """清掉本文件会用到的防刷键（冷却 / 日计数 / 全站 / 配置计数）"""

    async def _do() -> None:
        keys = await redis_client.keys(f'{settings.SMS_REDIS_PREFIX}:*')
        if keys:
            await redis_client.delete(*keys)

    client.portal.call(_do)
    yield
    client.portal.call(_do)


class TestHappyPathAndLogs:
    def test_send_writes_accepted_log_with_masked_params(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        cfg = make_config('ok', is_default=True)
        result = _send(client, phone=PHONE_A, template='captcha', params={'code': '123456', 'minutes': '5'}, user_id=1)
        assert result.status == 'accepted' and result.log_id

        rows = run_sync(_rows(PHONE_A))
        assert [str(r.id) for r in rows] == [result.log_id]
        row = rows[0]
        assert (
            row.status == SmsLogStatus.accepted.value and row.config_id == int(cfg['id']) and row.provider == 'console'
        )
        assert row.template == 'captcha' and row.template_id == 'DEV_CAPTCHA' and row.biz_id == result.log_id
        # 声明为敏感的 code 打码了，minutes 原样
        assert json.loads(row.params) == {'code': '***', 'minutes': '5'}
        assert row.phone == PHONE_A, '完整存，掩码只在列表接口'
        assert row.created_by == 1

    def test_failure_log_survives_and_cooldown_is_released(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        """🔴 失败也记（ContiNew 只在成功钩子里写）；确定没发出去 → 冷却位释放，马上能再试"""

        class Failing(SmsProvider):
            code, label, Config, template_mapping = 'pytest_failing', '必败', ConsoleConfig, TemplateMapping.named

            async def _send(self, msg: SmsMessage) -> SmsResult:
                return SmsResult.failed(SmsErrorKind.provider_error, provider_code='MOCK', provider_msg='always fails')

        register_provider(Failing)
        try:
            make_config('fail', provider='pytest_failing', is_default=True)
            err = _expect_error(
                client, 'provider_error', phone=PHONE_B, template='captcha', params={'code': '1', 'minutes': '5'}
            )
            assert err.code == 502 and err.result is not None and err.result.provider_code == 'MOCK'
            rows = run_sync(_rows(PHONE_B))
            assert len(rows) == 1 and rows[0].status == SmsLogStatus.failed.value
            assert (
                rows[0].error_kind == 'provider_error' and rows[0].provider_code == 'MOCK' and rows[0].id == err.log_id
            )
            # 冷却位已释放：再发不是 rate_limited，而是同样的 provider_error
            _expect_error(
                client, 'provider_error', phone=PHONE_B, template='captcha', params={'code': '1', 'minutes': '5'}
            )
            assert len(run_sync(_rows(PHONE_B))) == 2
        finally:
            unregister_provider('pytest_failing')

    def test_unknown_result_keeps_cooldown(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        class Flaky(SmsProvider):
            code, label, Config, template_mapping = 'pytest_flaky', '读超时', ConsoleConfig, TemplateMapping.named

            async def _send(self, msg: SmsMessage) -> SmsResult:
                raise TimeoutError('read timed out')

        register_provider(Flaky)
        try:
            make_config('flaky', provider='pytest_flaky', is_default=True)
            err = _expect_error(
                client, 'unknown', phone=PHONE_C, template='captcha', params={'code': '1', 'minutes': '5'}
            )
            assert err.code == 502
            assert run_sync(_rows(PHONE_C))[0].status == SmsLogStatus.unknown.value
            # 可能已发出 → 冷却位保留 → 马上再试被拦
            _expect_error(
                client, 'rate_limited', phone=PHONE_C, template='captcha', params={'code': '1', 'minutes': '5'}
            )
            assert len(run_sync(_rows(PHONE_C))) == 1, '被我们自己拦下的不写日志'
        finally:
            unregister_provider('pytest_flaky')


class TestValidation:
    def test_unknown_template_is_bad_params(self, client: TestClient) -> None:
        err = _expect_error(client, 'bad_params', phone=PHONE_A, template='nope', params={})
        assert err.code == 502

    def test_bad_phone_is_400(self, client: TestClient) -> None:
        err = _expect_error(
            client, 'invalid_phone', phone='12345', template='captcha', params={'code': '1', 'minutes': '5'}
        )
        assert err.code == 400

    def test_params_must_match_declaration_exactly(self, client: TestClient) -> None:
        _expect_error(client, 'bad_params', phone=PHONE_A, template='captcha', params={'code': '1'})
        _expect_error(
            client, 'bad_params', phone=PHONE_A, template='captcha', params={'code': '1', 'minutes': '5', 'extra': 'x'}
        )
        assert run_sync(_rows(PHONE_A)) == [], '校验失败不写日志'

    def test_no_config_is_an_explicit_error(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('other')  # 有配置，但没映射 pytest_orphan
        err = _expect_error(client, 'config_error', phone=PHONE_A, template='pytest_orphan', params={'x': '1'})
        assert 'pytest_orphan' in err.msg


class TestGuard:
    def test_cooldown_blocks_second_send_without_logging(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('cd', is_default=True)
        _send(client, phone=PHONE_A, template='captcha', params={'code': '1', 'minutes': '5'})
        err = _expect_error(
            client, 'rate_limited', phone=PHONE_A, template='captcha', params={'code': '2', 'minutes': '5'}
        )
        assert err.code == 400
        assert len(run_sync(_rows(PHONE_A))) == 1

    def test_phone_daily_limit(self, client: TestClient, make_config: Callable[..., dict[str, Any]]) -> None:
        make_config('pd', is_default=True, templates={'pytest_free': {'template_id': 'F', 'mapping': {'x': 'x'}}})
        _send(client, phone=PHONE_A, template='pytest_free', params={'x': '1'})
        _send(client, phone=PHONE_A, template='pytest_free', params={'x': '2'})
        _expect_error(client, 'rate_limited', phone=PHONE_A, template='pytest_free', params={'x': '3'})
        assert len(run_sync(_rows(PHONE_A))) == 2

    def test_global_circuit_breaker(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, 'SMS_GLOBAL_HOURLY_MAX', 1)
        make_config('cb', is_default=True, templates={'pytest_free': {'template_id': 'F', 'mapping': {'x': 'x'}}})
        _send(client, phone=PHONE_A, template='pytest_free', params={'x': '1'})
        err = _expect_error(client, CIRCUIT_OPEN, phone=PHONE_B, template='pytest_free', params={'x': '1'})
        assert err.code == 502
        assert run_sync(_rows(PHONE_B)) == [], '被熔断拦下的不写日志'

    def test_concurrent_sends_let_exactly_one_through(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        """🔴 三项检查和占位在同一段 Lua 里：并发不能同时穿过。先预热连接池，冷池会假绿（AI 确认令牌那条）"""
        make_config('cc', is_default=True)

        async def race() -> list[Any]:
            for _ in range(6):
                await redis_client.ping()
            return await asyncio.gather(
                *(
                    sms_service.send(phone=PHONE_A, template='captcha', params={'code': str(i), 'minutes': '5'})
                    for i in range(5)
                ),
                return_exceptions=True,
            )

        outcomes = client.portal.call(race)
        ok = [o for o in outcomes if not isinstance(o, BaseException)]
        blocked = [o for o in outcomes if isinstance(o, SmsSendError) and o.kind == 'rate_limited']
        assert len(ok) == 1 and len(blocked) == 4, outcomes
        assert len(run_sync(_rows(PHONE_A))) == 1

    def test_release_only_deletes_own_cooldown_slot(self, client: TestClient) -> None:
        """🔴 慢请求（连接超时最长 60 秒 = 冷却时长）判定「没连上」时自己占的位早已过期、别人已重新占上：
        它的释放不能把别人的冷却位删掉，否则第三条短信就穿过去了"""
        tpl = get_sms_template('captcha')
        assert tpl is not None and tpl.cooldown_seconds > 0

        async def _run() -> tuple[str | None, str | None]:
            assert await sms_guard.acquire(tpl, PHONE_C, 'old-token') == 'ok'
            # 模拟旧位过期、新请求重新占上
            await redis_client.delete(cooldown_key('captcha', PHONE_C))
            assert await sms_guard.acquire(tpl, PHONE_C, 'new-token') == 'ok'
            await sms_guard.release_cooldown(tpl, PHONE_C, 'old-token')
            kept = await redis_client.get(cooldown_key('captcha', PHONE_C))
            await sms_guard.release_cooldown(tpl, PHONE_C, 'new-token')
            gone = await redis_client.get(cooldown_key('captcha', PHONE_C))
            return kept, gone

        kept, gone = client.portal.call(_run)
        assert kept == 'new-token', '旧令牌的释放删掉了新请求的冷却位'
        assert gone is None, '持有正确令牌的释放要真删'


class TestRegistryOutsideWeb:
    def test_send_registers_builtin_templates_without_router_import(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """🔴 Celery worker 不 import 任何路由：注册表只在 `api/router.py` 装的话，定时任务里 `send()` 报
        「模板未注册」"""
        from backend.plugin.sms import extensions, templates
        from backend.plugin.sms.sdk import registry

        make_config('wk', is_default=True)
        monkeypatch.setattr(extensions, '_loaded', False)
        saved_templates, saved_providers = dict(templates._TEMPLATES), dict(registry._PROVIDERS)
        templates._TEMPLATES.clear()
        registry._PROVIDERS.clear()
        try:
            result = _send(client, phone=PHONE_A, template='captcha', params={'code': '1', 'minutes': '5'})
            assert result.status == 'accepted'
        finally:
            templates._TEMPLATES.update(saved_templates)
            registry._PROVIDERS.update(saved_providers)


class TestChooseConfig:
    def test_default_is_preferred_and_daily_cap_moves_to_backup(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        tpl = {'pytest_free': {'template_id': 'F', 'mapping': {'x': 'x'}}}
        default = make_config('main', is_default=True, daily_max=1, templates=tpl)
        backup = make_config('backup', weight=1, templates=tpl)
        first = _send(client, phone=PHONE_A, template='pytest_free', params={'x': '1'})
        second = _send(client, phone=PHONE_B, template='pytest_free', params={'x': '1'})
        rows = {str(r.id): r for r in run_sync(_rows(PHONE_A)) + run_sync(_rows(PHONE_B))}
        assert rows[first.log_id].config_id == int(default['id'])
        assert rows[second.log_id].config_id == int(backup['id']), '默认到了日上限要转备用'

    def test_zero_weight_only_when_specified(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        tpl = {'pytest_free': {'template_id': 'F', 'mapping': {'x': 'x'}}}
        normal = make_config('w1', weight=1, templates=tpl)
        manual = make_config('w0', weight=0, templates=tpl)
        auto = _send(client, phone=PHONE_A, template='pytest_free', params={'x': '1'})
        assert run_sync(_rows(PHONE_A))[0].config_id == int(normal['id'])
        picked = _send(client, phone=PHONE_B, template='pytest_free', params={'x': '1'}, config_id=int(manual['id']))
        assert run_sync(_rows(PHONE_B))[0].config_id == int(manual['id'])
        assert auto.log_id != picked.log_id

    def test_specified_config_must_be_enabled_and_mapped(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        disabled = make_config('off', status=0)
        _expect_error(
            client,
            'config_error',
            phone=PHONE_A,
            template='captcha',
            params={'code': '1', 'minutes': '5'},
            config_id=int(disabled['id']),
        )
        unmapped = make_config('unmapped', templates={})
        err = _expect_error(
            client,
            'config_error',
            phone=PHONE_A,
            template='captcha',
            params={'code': '1', 'minutes': '5'},
            config_id=int(unmapped['id']),
        )
        assert 'captcha' in err.msg
        _expect_error(
            client, 'config_error', phone=PHONE_A, template='captcha', params={'code': '1', 'minutes': '5'}, config_id=1
        )

    def test_disabled_config_is_never_auto_picked(
        self, client: TestClient, make_config: Callable[..., dict[str, Any]]
    ) -> None:
        make_config('only-off', status=0, is_default=False)
        _expect_error(client, 'config_error', phone=PHONE_A, template='captcha', params={'code': '1', 'minutes': '5'})
