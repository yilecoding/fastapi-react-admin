"""厂商注册表。内置三家在这里登记；下游项目在自己的插件里放一个 `sms_providers.py`，
短信插件启动时会扫描并 import 它（扫描在插件层 `plugin/sms/extensions.py`，这一层不认识 `backend.*`）。
"""

from __future__ import annotations

import importlib

from typing import Any

from backend.plugin.sms.sdk.base import SmsProvider

_PROVIDERS: dict[str, type[SmsProvider]] = {}


def register_provider(cls: type[SmsProvider]) -> type[SmsProvider]:
    """装饰器：登记一家厂商。形状不对**当场抛** —— 不等到发送时才发现"""
    if not (isinstance(cls, type) and issubclass(cls, SmsProvider)):
        raise TypeError(f'{cls!r} 不是 SmsProvider 的子类')
    cls.validate_class()
    existing = _PROVIDERS.get(cls.code)
    if existing is not None and existing is not cls:
        # 同一个模块被 import 两次会拿到同一个类对象，放过；两个不同的类抢一个码才是真冲突
        raise ValueError(f'厂商码 {cls.code!r} 已被 {existing.__module__}.{existing.__name__} 注册')
    _PROVIDERS[cls.code] = cls
    return cls


def unregister_provider(code: str) -> None:
    """只给测试和「生产环境摘掉控制台」用"""
    _PROVIDERS.pop(code, None)


def get_provider(code: str) -> type[SmsProvider] | None:
    return _PROVIDERS.get(code)


def list_providers() -> list[type[SmsProvider]]:
    return [_PROVIDERS[k] for k in sorted(_PROVIDERS)]


def provider_descriptor(cls: type[SmsProvider]) -> dict[str, Any]:
    """给配置页用：这家叫什么、要哪些配置字段（从 `Config` 的 JSON Schema 来）、模板映射形状"""
    schema = cls.Config.model_json_schema()
    properties: dict[str, Any] = dict(schema.get('properties', {}))
    required = set(schema.get('required', []))
    credential = None
    if cls.credential_fields is not None:
        key_field, secret_field = cls.credential_fields
        credential = {
            'key_field': key_field,
            'key_label': properties.get(key_field, {}).get('title') or key_field,
            'secret_field': secret_field,
            'secret_label': properties.get(secret_field, {}).get('title') or secret_field,
        }
        properties.pop(key_field, None)
        properties.pop(secret_field, None)
        required.discard(key_field)
        required.discard(secret_field)
    return {
        'code': cls.code,
        'label': cls.label,
        'template_mapping': cls.template_mapping.value,
        'template_id_hint': cls.template_id_hint,
        'credential': credential,
        'options_schema': {
            'type': 'object',
            'properties': properties,
            'required': sorted(required),
            '$defs': schema.get('$defs', {}),
        },
    }


def load_builtin_providers(*, include_console: bool) -> None:
    """import 内置三家（import 即注册）。

    🔴 `include_console=False` 时控制台厂商**不在注册表里**：生产库里即使有一条 `console` 配置，
    保存和发送也明确报「厂商不存在」。不能只靠 `check_production_settings`，它只看配置项、看不到库里的行。
    """
    modules = ['backend.plugin.sms.sdk.aliyun', 'backend.plugin.sms.sdk.tencent']
    if include_console:
        modules.append('backend.plugin.sms.sdk.console')
    else:
        unregister_provider('console')
    for name in modules:
        module = importlib.import_module(name)
        # ⚠️ 不能只靠「import 即注册」：模块已经在 sys.modules 里时装饰器不会再跑一遍 ——
        # 摘掉 console 再装回来（测试里会）就会悄悄少一家。按模块里的类显式再登记一次（幂等）
        for obj in vars(module).values():
            if (
                isinstance(obj, type)
                and issubclass(obj, SmsProvider)
                and obj is not SmsProvider
                and 'code' in vars(obj)
            ):
                register_provider(obj)
