"""业务模板注册表（插件层，issue #153 第三节第 1 条）。

使用方只认**业务模板码**（`captcha`），配置页把它对到每家厂商自己的模板 ID 和参数 ——
换厂商不改调用方代码。使用方在自己的模块里声明（import 时注册）：

```python
register_sms_template(
    'captcha',
    label='验证码',
    params=('code', 'minutes'),
    sensitive=('code',),  # 落日志时打码
    cooldown_seconds=60,  # 同一号码同一模板的冷却；0 = 不限
    daily_max_per_phone=10,  # 同一号码同一模板的日上限；0 = 不限
)
```

`sensitive` / `cooldown_seconds` / `daily_max_per_phone` **是必填关键字参数**，不给默认值：声明的人必须想一次。
"""

from __future__ import annotations

import re

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

_CODE_RE = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
_PARAM_RE = re.compile(r'^[a-z][a-z0-9_]{0,31}$')


@dataclass(frozen=True, slots=True)
class SmsTemplate:
    code: str
    label: str
    #: 使用方调用 `send()` 时必须给全的参数
    params: tuple[str, ...]
    #: 落日志时打码的参数
    sensitive: frozenset[str]
    cooldown_seconds: int
    daily_max_per_phone: int


_TEMPLATES: dict[str, SmsTemplate] = {}


def register_sms_template(
    code: str,
    *,
    label: str,
    params: Sequence[str],
    sensitive: Sequence[str],
    cooldown_seconds: int,
    daily_max_per_phone: int,
) -> SmsTemplate:
    """声明一个业务模板。重复声明**同样的内容**是幂等的（模块被 import 两次）；内容不同就是冲突，当场抛"""
    if not _CODE_RE.match(code):
        raise ValueError(f'业务模板码 {code!r} 必须是小写字母开头的 [a-z0-9_]，最长 64')
    if not label:
        raise ValueError(f'业务模板 {code} 必须有 label')
    params_t = tuple(params)
    if not params_t or len(set(params_t)) != len(params_t):
        raise ValueError(f'业务模板 {code} 的 params 不能为空、不能重复')
    for p in params_t:
        if not _PARAM_RE.match(p):
            raise ValueError(f'业务模板 {code} 的参数名 {p!r} 必须是小写字母开头的 [a-z0-9_]，最长 32')
    sensitive_s = frozenset(sensitive)
    if not sensitive_s <= set(params_t):
        raise ValueError(f'业务模板 {code} 的 sensitive 引用了没声明的参数：{sorted(sensitive_s - set(params_t))}')
    if cooldown_seconds < 0 or daily_max_per_phone < 0:
        raise ValueError(f'业务模板 {code} 的 cooldown_seconds / daily_max_per_phone 不能是负数')

    template = SmsTemplate(code, label, params_t, sensitive_s, int(cooldown_seconds), int(daily_max_per_phone))
    existing = _TEMPLATES.get(code)
    if existing is not None and existing != template:
        raise ValueError(f'业务模板 {code} 已经注册过且定义不同：{existing} vs {template}')
    _TEMPLATES[code] = template
    return template


def get_sms_template(code: str) -> SmsTemplate | None:
    return _TEMPLATES.get(code)


def list_sms_templates() -> list[SmsTemplate]:
    return [_TEMPLATES[k] for k in sorted(_TEMPLATES)]


def load_builtin_templates() -> None:
    """插件自带的声明。

    `captcha` 是**声明**不是使用方：验证码登录 / 绑定手机号那条路另开 issue 做，但模板码要先有，
    配置页才有东西可映射、「配置一下就能用」才成立。参数两个（阿里云验证码模板只映射 `code`，
    腾讯云的常见模板是「验证码 {1}，{2} 分钟内有效」两个都用）。
    """
    register_sms_template(
        'captcha',
        label='验证码',
        params=('code', 'minutes'),
        sensitive=('code',),
        cooldown_seconds=60,
        daily_max_per_phone=10,
    )
