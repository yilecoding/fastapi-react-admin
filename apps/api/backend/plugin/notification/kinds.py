"""通知类型（kind）注册表（#166 第一节）。

使用方在自己的插件里放一个 `notification_kinds.py`，import 时 `register_notification_kind(...)`；
`extensions.load_notification_extensions()` 启动时扫描 —— 和短信插件扫 `sms_templates.py` 同一个机制，
依赖方向是「业务插件 → 通知插件」，不改通知插件源码。

kind 比 `NotificationCategory` 细一级：每个 kind 归属一个分类（收件箱按分类筛、红点按分类数），
**路由按 kind 决定**（这条通知走哪几条渠道）。分类的数值是前端契约，不因为加 kind 而变。

```python
register_notification_kind(
    'workflow.remind',
    label='审批催办',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_on', 'sms': 'default_off'},
    sms_template='workflow_remind',
    sms_params=lambda title, content: {'title': title[:20]},
)
```

`defaults` 里**没出现的渠道 = 这个类型不支持**（策略页上那一格不出现、保存时 400）。
"""

from __future__ import annotations

import re

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from backend.plugin.notification.enums import NotificationCategory, NotificationChannel, PolicyMode

_KIND_RE = re.compile(r'^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$')

#: 短信参数怎么从一条通知算出来：入参是 (title, content)，出参是短信业务模板的参数
SmsParamsBuilder = Callable[[str, str], Mapping[str, str]]


@dataclass(frozen=True, slots=True)
class NotificationKind:
    code: str
    label: str
    category: NotificationCategory
    #: 渠道 → 默认策略。没出现的渠道 = 不支持
    defaults: Mapping[NotificationChannel, PolicyMode]
    #: False：个人中心不显示这一行（安全类通知不让人自己关）
    user_configurable: bool = True
    #: 全员广播。🔴 外部渠道只能是 off：站内广播是一行不 fan-out，外部渠道必然 fan-out 成全员群发
    broadcast: bool = False
    #: 走短信时用哪个短信业务模板（`plugin/sms/templates.py` 注册的码）
    sms_template: str | None = None
    sms_params: SmsParamsBuilder | None = field(default=None, compare=False)

    @property
    def channels(self) -> tuple[NotificationChannel, ...]:
        """支持的渠道，按枚举顺序（前端矩阵的列序）"""
        return tuple(c for c in NotificationChannel if c in self.defaults)

    @property
    def writes_inbox(self) -> bool:
        """会不会写站内行。只有「你有新的待办」不写（靠待办数红点感知，见 `workflow/notification_kinds.py`）"""
        return NotificationChannel.inapp in self.defaults


_KINDS: dict[str, NotificationKind] = {}


def register_notification_kind(
    code: str,
    *,
    label: str,
    category: NotificationCategory,
    defaults: Mapping[str, str],
    user_configurable: bool = True,
    broadcast: bool = False,
    sms_template: str | None = None,
    sms_params: SmsParamsBuilder | None = None,
) -> NotificationKind:
    """声明一个通知类型。重复声明同样的内容是幂等的（模块被 import 两次）；内容不同就是冲突，当场抛"""
    if not _KIND_RE.match(code) or len(code) > 64:
        raise ValueError(f'通知类型码 {code!r} 只能是小写字母开头的 [a-z0-9_]，可用点分层（`模块.动作`），最长 64')
    if not label:
        raise ValueError(f'通知类型 {code} 必须有 label')
    try:
        parsed = {NotificationChannel(k): PolicyMode(v) for k, v in defaults.items()}
    except ValueError as e:
        raise ValueError(f'通知类型 {code} 的 defaults 里有不认识的渠道或策略：{e}') from e
    if not parsed:
        raise ValueError(f'通知类型 {code} 至少要支持一条渠道')
    inapp = parsed.get(NotificationChannel.inapp)
    if inapp is not None and inapp is not PolicyMode.forced:
        # 站内行是收件箱的事实来源：关掉它等于「发了但哪儿都查不到」。不想写站内行就别声明 inapp
        raise ValueError(f'通知类型 {code} 的站内渠道只能是 forced（不想写站内行就不要声明 inapp）')
    if broadcast and any(c is not NotificationChannel.inapp for c in parsed):
        raise ValueError(f'通知类型 {code} 是全员广播，一期只许走站内')
    if NotificationChannel.sms in parsed and (not sms_template or sms_params is None):
        # 国内短信只能发审核过的模板，不能发自由文本 —— 走短信的类型必须说清楚用哪个模板、参数怎么来
        raise ValueError(f'通知类型 {code} 支持短信，必须给 sms_template 和 sms_params')

    kind = NotificationKind(
        code=code,
        label=label,
        category=category,
        defaults=parsed,
        user_configurable=user_configurable,
        broadcast=broadcast,
        sms_template=sms_template,
        sms_params=sms_params,
    )
    existing = _KINDS.get(code)
    if existing is not None and existing != kind:
        raise ValueError(f'通知类型 {code} 已经注册过且定义不同：{existing} vs {kind}')
    _KINDS[code] = kind
    return kind


def get_notification_kind(code: str) -> NotificationKind | None:
    return _KINDS.get(code)


def require_notification_kind(code: str) -> NotificationKind:
    """调用方传了没注册的 kind 是代码 bug，当场抛 —— 不静默当成「只发站内」"""
    from backend.plugin.notification.extensions import load_notification_extensions

    load_notification_extensions()
    kind = _KINDS.get(code)
    if kind is None:
        raise LookupError(f'通知类型 {code} 没有注册（在插件的 notification_kinds.py 里 register_notification_kind）')
    return kind


def list_notification_kinds() -> list[NotificationKind]:
    return [_KINDS[k] for k in sorted(_KINDS)]


def load_builtin_kinds() -> None:
    """通知插件自己（以及没有插件可挂的平台核心）的类型。审批 / 公告各自在自己插件里声明"""
    register_notification_kind(
        'system',
        label='系统通知',
        category=NotificationCategory.SYSTEM,
        defaults={'inapp': 'forced', 'email': 'default_off'},
    )
    register_notification_kind(
        'system.greeting',
        label='每日问候',
        category=NotificationCategory.SYSTEM,
        defaults={'inapp': 'forced'},
        user_configurable=False,
        broadcast=True,
    )
    # 后台导出（`app/task/tasks/export/tasks.py`）是平台核心，没有插件可挂，类型放这里
    register_notification_kind(
        'export.done',
        label='导出完成',
        category=NotificationCategory.TASK,
        defaults={'inapp': 'forced', 'email': 'default_off'},
    )
    register_notification_kind(
        'export.failed',
        label='导出失败',
        category=NotificationCategory.TASK,
        defaults={'inapp': 'forced', 'email': 'default_off'},
    )
