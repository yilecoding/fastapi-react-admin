"""短信 SDK（对标 SMS4J）：厂商基类 + 注册表 + 内置三家。

🔴 **这一层不认识数据库、Redis、FastAPI**（`backend.*` 一个都不 import，守卫
`tests/test_sms_guards.py::TestSdkPurity` 按 AST 扫）。输入一份配置 + 一条短信，
输出一个 `SmsResult`。定时任务、脚本、别的项目都能直接拿去用。
"""

from backend.plugin.sms.sdk.base import (
    UNSENT_KINDS,
    SmsErrorKind,
    SmsMessage,
    SmsProvider,
    SmsResult,
    SmsStatus,
    TemplateMapping,
    render_template_params,
    validate_template_mapping,
)
from backend.plugin.sms.sdk.registry import (
    get_provider,
    list_providers,
    load_builtin_providers,
    provider_descriptor,
    register_provider,
)

__all__ = [
    'UNSENT_KINDS',
    'SmsErrorKind',
    'SmsMessage',
    'SmsProvider',
    'SmsResult',
    'SmsStatus',
    'TemplateMapping',
    'get_provider',
    'list_providers',
    'load_builtin_providers',
    'provider_descriptor',
    'register_provider',
    'render_template_params',
    'validate_template_mapping',
]
