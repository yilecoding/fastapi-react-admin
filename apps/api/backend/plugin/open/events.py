"""Webhook 事件目录（#167）：哪些事件能订阅、要什么 scope、长什么样。

同通知类型 / 短信业务模板的注册表：各插件在自己的 `webhook_events.py` 里 `register_webhook_event(...)`，
`load_webhook_extensions()` 扫描并 import。用户 / 部门不在插件里，内置在这里。

🔴 **worker 侧也要装**（短信插件那条坑）：投递任务和审批超时都在 Celery 里跑，那边不 import 路由。
所以 `require_webhook_event()` / `emit` 每次都调一下 `load_webhook_extensions()`（幂等）。

🔴 **data 是 thin 的**：只给标识和状态，不给表单内容、手机号、邮箱。对方要详情拿 AK/SK 来拉 —— 读权限只有一条路，
走 scope 和调用日志（Standard Webhooks 原文：thin「more future proof」，能升 full，反过来不行）。
"""

from __future__ import annotations

import importlib
import importlib.util
import pkgutil

from dataclasses import dataclass, field
from typing import Any

from backend.common.log import log

#: 「发测试事件」用的类型：不在目录里，任何端点都收（不看订阅、不看 scope）
PING = 'ping'


@dataclass(frozen=True, slots=True)
class WebhookEvent:
    type: str
    label: str
    #: 应用要授权了这个 scope，它的端点才收得到这个事件（撤销 scope 即停投）
    scope: str
    #: 事件目录里给对方看的示例 data
    sample: dict[str, Any] = field(default_factory=dict)


WEBHOOK_EVENTS: dict[str, WebhookEvent] = {}


def register_webhook_event(type: str, *, label: str, scope: str, sample: dict[str, Any]) -> WebhookEvent:
    """登记一个事件类型。重复登记同一个 type 直接报错 —— 两个插件抢一个名字，后来者会静默盖掉前者"""
    if type in WEBHOOK_EVENTS:
        raise ValueError(f'Webhook 事件 {type} 重复登记')
    if type == PING or '*' in type or type.count('.') < 1:
        raise ValueError(f'Webhook 事件类型 {type!r} 不合法：要写成 <对象>.<动作>，且不能含 *')
    event = WebhookEvent(type=type, label=label, scope=scope, sample=sample)
    WEBHOOK_EVENTS[type] = event
    return event


def get_webhook_event(type: str) -> WebhookEvent | None:
    load_webhook_extensions()
    return WEBHOOK_EVENTS.get(type)


def matches(patterns: list[str], type: str) -> bool:
    """订阅是否命中：精确匹配，或 `user.*` 这种前缀通配（只认末尾的 `.*`）"""
    return any(p == type or (p.endswith('.*') and type.startswith(p[:-1])) for p in patterns)


def unknown_patterns(patterns: list[str]) -> list[str]:
    """一个都匹配不上的订阅。存进去的话，表现是「端点从来收不到东西」，看起来像网络问题"""
    load_webhook_extensions()
    return [p for p in patterns if not any(matches([p], t) for t in WEBHOOK_EVENTS)]


_USER_SAMPLE = {'id': '2049629108245233664', 'username': 'zhangwei', 'dept_id': '2048601263515500544', 'status': 1}
_DEPT_SAMPLE = {
    'id': '2048601263515500544',
    'code': 'HQ',
    'name': '总部',
    'parent_id': None,
    'status': 1,
}


def load_builtin_events() -> None:
    builtin = [
        ('user.created', '用户已创建', 'user:read', _USER_SAMPLE),
        ('user.updated', '用户资料已修改', 'user:read', _USER_SAMPLE),
        ('user.status_changed', '用户已启用 / 停用', 'user:read', {**_USER_SAMPLE, 'status': 0}),
        ('user.deleted', '用户已删除', 'user:read', _USER_SAMPLE),
        ('dept.created', '部门已创建', 'dept:read', _DEPT_SAMPLE),
        ('dept.updated', '部门已修改', 'dept:read', _DEPT_SAMPLE),
        ('dept.deleted', '部门已删除', 'dept:read', _DEPT_SAMPLE),
    ]
    for type_, label, scope, sample in builtin:
        if type_ not in WEBHOOK_EVENTS:
            register_webhook_event(type_, label=label, scope=scope, sample=sample)


_EXTENSION_MODULE = 'webhook_events'
_loaded = False


def load_webhook_extensions(*, force: bool = False) -> None:
    """内置事件 + 扫描别的插件的 `webhook_events.py`。幂等"""
    global _loaded
    if _loaded and not force:
        return
    load_builtin_events()

    import backend.plugin as plugin_pkg

    for module in pkgutil.iter_modules(plugin_pkg.__path__):
        if not module.ispkg or module.name == 'open':
            continue
        name = f'backend.plugin.{module.name}.{_EXTENSION_MODULE}'
        if importlib.util.find_spec(name) is None:
            continue
        # 不吞异常：重复登记 / 类型名不合法就该在启动时炸
        importlib.import_module(name)
        log.info(f'能力开放加载 Webhook 事件：{name}')
    _loaded = True
