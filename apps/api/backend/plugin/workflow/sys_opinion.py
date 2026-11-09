"""系统意见：流程自己写进轨迹 / 待办的那句话（「没有找到审批人，已自动驳回」「超过 2 小时未处理，已自动同意」…）。

🔴 **落库存「消息键 + 参数」，读的时候按当前请求的语言渲染。** 原来是写入那一刻 `t()` 一下、成品文本直接当
`opinion` 存：英文界面的人触发的自动驳回永远是英文，中文界面的仪表盘里就中英混排；超时 / AI 自动同意在 Celery
里跑、没有请求语言，永远是默认语言。

两列分工：
- `opinion` 照旧存一份**默认语言**的成品文本 —— 旧客户端、直接查库的报表、`FinishEvent` 都还认它，含义不变
- `opinion_i18n` 存 `{"key": ..., "args": {...}}`；为空 = 用户自己写的意见，或者修之前落的老数据，原样返回

读的地方一律过 `render()`（`query_service` 里详情的 `tasks` / `records`、「我发起的」的 `last`）。
漏了哪一处的后果是退回旧行为（显示默认语言），不会把消息键露给用户。
"""

from __future__ import annotations

import json

from dataclasses import dataclass, field
from typing import Any

from backend.common.i18n import i18n, t
from backend.common.log import log
from backend.core.conf import settings


@dataclass(frozen=True)
class SysOpinion:
    key: str
    args: dict[str, Any] = field(default_factory=dict)

    def text(self) -> str:
        """按当前语言渲染（给通知、业务回调这类**当场**用掉的地方）"""
        return t(self.key, **self.args)

    def stored_text(self) -> str:
        """落进 `opinion` 列的那份：固定默认语言，不随触发的人变"""
        with i18n.use_language(settings.I18N_DEFAULT_LANGUAGE):
            return t(self.key, **self.args)

    def dump(self) -> str:
        return json.dumps({'key': self.key, 'args': self.args}, ensure_ascii=False)


def render(opinion: str | None, opinion_i18n: str | None) -> str | None:
    """读出来给人看的意见：有消息键就按当前语言渲染，否则原样返回 `opinion`"""
    if not opinion_i18n:
        return opinion
    try:
        data = json.loads(opinion_i18n)
        key = data['key']
        out = t(key, **(data.get('args') or {}))
    except (ValueError, KeyError, IndexError, TypeError) as e:
        log.warning(f'系统意见渲染失败，退回存的文本：{opinion_i18n!r}（{e!r}）')
        return opinion
    # 键在语言包里没了（改名 / 删了）：`t()` 会把键原样吐回来，那还不如存的文本
    return opinion if out == key else out
