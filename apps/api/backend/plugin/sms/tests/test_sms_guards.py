"""守卫：写错了不报错的那一类（issue #153「测试与验收」里的守卫项）。

- SDK 层不许 import `backend.*` / sqlalchemy / redis / fastapi（AST 扫）
- 腾讯云适配器永远不设 `HttpProfile.proxy`
- 生产环境下 `console` 不在注册表里
- plugin.toml 的配置项都在 `Settings` 里声明过（否则容器环境变量覆盖不了）
- `access_key_secret` 在操作日志的脱敏名单里
- 注册表 / 模板注册表的形状检查真的会拦
- 选配置的纯规则
"""

from __future__ import annotations

import ast
import random

from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.core.conf import Settings, settings
from backend.plugin.sms.extensions import console_provider_allowed
from backend.plugin.sms.sdk.base import SmsMessage, SmsProvider, SmsResult, TemplateMapping
from backend.plugin.sms.sdk.console import ConsoleConfig
from backend.plugin.sms.sdk.registry import get_provider, load_builtin_providers, register_provider, unregister_provider
from backend.plugin.sms.service.sms_service import pick_config
from backend.plugin.sms.templates import register_sms_template

PLUGIN_DIR = Path(__file__).resolve().parents[1]
SDK_DIR = PLUGIN_DIR / 'sdk'


class TestSdkPurity:
    """🔴 SDK 一旦依赖数据库或 Redis，就不能在脚本 / 别的项目里单独用，也没法脱离插件做契约测试"""

    FORBIDDEN_ROOTS = ('sqlalchemy', 'redis', 'fastapi', 'starlette')

    @staticmethod
    def _imports(path: Path) -> list[tuple[int, str]]:
        found: list[tuple[int, str]] = []
        for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
            if isinstance(node, ast.Import):
                found += [(node.lineno, a.name) for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                found.append((node.lineno, node.module))
        return found

    def test_sdk_never_imports_backend_outside_itself(self) -> None:
        offenders = []
        for path in sorted(SDK_DIR.glob('*.py')):
            for lineno, module in self._imports(path):
                if module.startswith('backend.') and not module.startswith('backend.plugin.sms.sdk'):
                    offenders.append(f'{path.name}:{lineno} {module}')
                if module.split('.')[0] in self.FORBIDDEN_ROOTS:
                    offenders.append(f'{path.name}:{lineno} {module}')
        assert not offenders, f'SDK 层不许依赖这些：{offenders}'

    def test_scanner_sees_the_sdk(self) -> None:
        """守卫的守卫：目录挪走时上面那条会以「什么都没扫到」的方式假绿"""
        files = list(SDK_DIR.glob('*.py'))
        assert {f.name for f in files} >= {'base.py', 'registry.py', 'aliyun.py', 'tencent.py', 'console.py'}
        assert sum(len(self._imports(f)) for f in files) >= 20


def test_tencent_adapter_never_sets_http_proxy() -> None:
    """🔴 异步客户端一设 `HttpProfile.proxy` 就 `TypeError: ... unexpected keyword argument 'proxies'`"""
    tree = ast.parse((SDK_DIR / 'tencent.py').read_text(encoding='utf-8'))
    offenders = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, 'id', None) == 'HttpProfile':
            offenders += [f'{node.lineno} HttpProfile(proxy=…)' for kw in node.keywords if kw.arg == 'proxy']
        if isinstance(node, ast.Assign):
            offenders += [
                f'{node.lineno} .proxy = …' for t in node.targets if isinstance(t, ast.Attribute) and t.attr == 'proxy'
            ]
    assert not offenders, offenders


class TestConsoleProviderInProduction:
    def test_console_is_unregistered_when_excluded(self) -> None:
        try:
            load_builtin_providers(include_console=False)
            assert get_provider('console') is None
            assert get_provider('aliyun') is not None and get_provider('tencent') is not None
        finally:
            load_builtin_providers(include_console=True)
        assert get_provider('console') is not None

    def test_prod_environment_disallows_console(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(settings, 'ENVIRONMENT', 'prod')
        assert console_provider_allowed() is False
        monkeypatch.setattr(settings, 'ENVIRONMENT', 'dev')
        assert console_provider_allowed() is True


def test_every_plugin_setting_is_a_declared_field() -> None:
    """🔴 只写在 plugin.toml 里的配置是 extra，进程环境变量覆盖不了（open 插件实测踩过）"""
    import rtoml

    keys = rtoml.load(PLUGIN_DIR / 'plugin.toml')['settings']
    assert 'SMS_ENCRYPT_SECRET_KEY' in keys
    assert set(keys) <= set(Settings.model_fields), set(keys) - set(Settings.model_fields)


def test_access_key_secret_is_redacted_in_opera_log() -> None:
    assert 'access_key_secret' in settings.OPERA_LOG_REDACT_KEYS


class TestProviderRegistryValidation:
    """注册时校验：不合格启动时就报错，不等到发送"""

    def test_sync_send_is_rejected(self) -> None:
        class Bad(SmsProvider):
            code, label, Config, template_mapping = 'pytest_bad_sync', 'x', ConsoleConfig, TemplateMapping.named

            def _send(self, msg: SmsMessage) -> SmsResult:  # type: ignore[override]
                raise NotImplementedError

        with pytest.raises(TypeError, match='async def'):
            register_provider(Bad)
        assert get_provider('pytest_bad_sync') is None

    def test_duplicate_code_is_rejected(self) -> None:
        class Dup(SmsProvider):
            code, label, Config, template_mapping = 'console', '假的控制台', ConsoleConfig, TemplateMapping.named

            async def _send(self, msg: SmsMessage) -> SmsResult:
                raise NotImplementedError

        with pytest.raises(ValueError, match='已被'):
            register_provider(Dup)

    def test_credential_fields_must_exist_in_config(self) -> None:
        class Bad(SmsProvider):
            code, label, Config, template_mapping = 'pytest_bad_cred', 'x', ConsoleConfig, TemplateMapping.named
            credential_fields = ('ak', 'sk')

            async def _send(self, msg: SmsMessage) -> SmsResult:
                raise NotImplementedError

        with pytest.raises(TypeError, match='credential_fields'):
            register_provider(Bad)

    def test_config_must_be_pydantic(self) -> None:
        class Bad(SmsProvider):
            code, label, Config, template_mapping = 'pytest_bad_cfg', 'x', dict, TemplateMapping.named  # type: ignore[assignment]

            async def _send(self, msg: SmsMessage) -> SmsResult:
                raise NotImplementedError

        with pytest.raises(TypeError, match='pydantic'):
            register_provider(Bad)

    def test_valid_third_party_registers_and_unregisters(self) -> None:
        class Ok(SmsProvider):
            code, label, Config, template_mapping = 'pytest_ok', '第三方', ConsoleConfig, TemplateMapping.ordered

            async def _send(self, msg: SmsMessage) -> SmsResult:
                return SmsResult.accepted(provider_code='OK', provider_msg=None, request_id=None, biz_id=None)

        try:
            assert register_provider(Ok) is Ok and get_provider('pytest_ok') is Ok
        finally:
            unregister_provider('pytest_ok')
        assert get_provider('pytest_ok') is None


class TestTemplateRegistryValidation:
    def test_sensitive_must_be_declared_param(self) -> None:
        with pytest.raises(ValueError, match='sensitive'):
            register_sms_template(
                'pytest_bad_sens',
                label='x',
                params=('code',),
                sensitive=('nope',),
                cooldown_seconds=0,
                daily_max_per_phone=0,
            )

    def test_redefining_with_different_shape_conflicts(self) -> None:
        register_sms_template(
            'pytest_dup', label='x', params=('a',), sensitive=(), cooldown_seconds=1, daily_max_per_phone=1
        )
        # 同样的内容是幂等的
        register_sms_template(
            'pytest_dup', label='x', params=('a',), sensitive=(), cooldown_seconds=1, daily_max_per_phone=1
        )
        with pytest.raises(ValueError, match='定义不同'):
            register_sms_template(
                'pytest_dup', label='x', params=('a', 'b'), sensitive=(), cooldown_seconds=1, daily_max_per_phone=1
            )

    @pytest.mark.parametrize('code', ['Captcha', '1abc', 'a-b', ''])
    def test_code_shape(self, code: str) -> None:
        with pytest.raises(ValueError):
            register_sms_template(
                code, label='x', params=('a',), sensitive=(), cooldown_seconds=0, daily_max_per_phone=0
            )


def _cfg(pk: int, *, is_default: bool = False, weight: int = 1) -> SimpleNamespace:
    return SimpleNamespace(id=pk, is_default=is_default, weight=weight)


class TestPickConfig:
    """第二节第 4 条的纯规则"""

    def test_single_config_is_always_picked(self) -> None:
        only = _cfg(1)
        assert pick_config([only]) is only

    def test_default_wins_regardless_of_weight(self) -> None:
        default = _cfg(1, is_default=True, weight=0)
        assert pick_config([_cfg(2, weight=100), default]) is default

    def test_zero_weight_is_never_picked_automatically(self) -> None:
        heavy, zero = _cfg(1, weight=1), _cfg(2, weight=0)
        rng = random.Random(0)
        assert all(pick_config([heavy, zero], rng=rng) is heavy for _ in range(200))

    def test_only_zero_weights_means_nothing_is_picked(self) -> None:
        assert pick_config([_cfg(1, weight=0), _cfg(2, weight=0)]) is None
        assert pick_config([]) is None

    def test_weights_shape_the_distribution(self) -> None:
        a, b = _cfg(1, weight=3), _cfg(2, weight=1)
        rng = random.Random(42)
        picks = [pick_config([a, b], rng=rng) for _ in range(4000)]
        share = picks.count(a) / len(picks)
        assert 0.70 < share < 0.80, share
