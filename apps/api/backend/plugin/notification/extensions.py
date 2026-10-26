"""把内置通知类型和别的插件声明的通知类型装起来（#166）。

同短信插件 `extensions.py`：各插件放 `notification_kinds.py`，这里扫描并 import。

🔴 **不能只在 `api/router.py` 装**（短信插件踩过）：Celery worker 不 import 任何路由，投递任务里查 kind
会报「未注册」，而同一段代码在 uvicorn 里是好的。所以 `kinds.require_notification_kind()` 每次都调一下（幂等）。
"""

from __future__ import annotations

import importlib
import importlib.util
import pkgutil

from backend.common.log import log
from backend.plugin.notification.kinds import load_builtin_kinds

_EXTENSION_MODULE = 'notification_kinds'
_loaded = False


def load_notification_extensions(*, force: bool = False) -> None:
    """内置类型 + 扫描别的插件的 `notification_kinds.py`。幂等"""
    global _loaded
    if _loaded and not force:
        return
    load_builtin_kinds()

    import backend.plugin as plugin_pkg

    for module in pkgutil.iter_modules(plugin_pkg.__path__):
        if not module.ispkg or module.name == 'notification':
            continue
        name = f'backend.plugin.{module.name}.{_EXTENSION_MODULE}'
        if importlib.util.find_spec(name) is None:
            continue
        # 不吞异常：注册表的形状检查（kind 重复 / 站内不是 forced / 短信没给模板）就该在启动时炸
        importlib.import_module(name)
        log.info(f'通知插件加载扩展：{name}')
    _loaded = True
