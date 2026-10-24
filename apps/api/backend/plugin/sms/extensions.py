"""把 SDK 注册表、业务模板注册表和下游插件的扩展装起来。

和 AI 插件发现各插件 `ai_tools.py` 是同一个机制（`plugin/ai/core/registry.py`）：下游项目在自己的插件里放
`sms_providers.py`（继承 `SmsProvider` + `@register_provider`）或 `sms_templates.py`（`register_sms_template(...)`），
短信插件启动时扫描并 import —— 依赖方向是「业务插件 → 短信插件」，不改短信插件源码。

⚠️ 放在路由装配时调（`api/router.py`）而不是某个 startup 钩子：插件加载器一定会 import 那个模块，
而「没被 import 的厂商等于不存在」的表现是配置页下拉里少一家 —— 不报错。
"""

from __future__ import annotations

import importlib
import importlib.util
import pkgutil

from backend.common.log import log
from backend.core.conf import settings
from backend.plugin.sms.sdk.registry import load_builtin_providers
from backend.plugin.sms.templates import load_builtin_templates

_EXTENSION_MODULES = ('sms_providers', 'sms_templates')
_loaded = False


def console_provider_allowed() -> bool:
    """控制台厂商只在非生产环境注册

    🔴 不能只靠 `check_production_settings`：它只看配置项，看不到库里的行。生产库里即使有一条
    `console` 配置，注册表里没有它，保存和发送就会明确报「厂商不存在」。
    """
    return settings.ENVIRONMENT != 'prod'


def load_sms_extensions(*, force: bool = False) -> None:
    """内置厂商 + 内置模板 + 扫描别的插件带来的扩展。幂等"""
    global _loaded
    if _loaded and not force:
        return
    load_builtin_providers(include_console=console_provider_allowed())
    load_builtin_templates()

    import backend.plugin as plugin_pkg

    for module in pkgutil.iter_modules(plugin_pkg.__path__):
        if not module.ispkg or module.name == 'sms':
            continue
        for ext in _EXTENSION_MODULES:
            name = f'backend.plugin.{module.name}.{ext}'
            if importlib.util.find_spec(name) is None:
                continue
            # 不吞异常：注册表的形状检查（厂商码重复 / Config 不是 pydantic / _send 不是协程）就该在启动时炸
            importlib.import_module(name)
            log.info(f'短信插件加载扩展：{name}')
    _loaded = True
