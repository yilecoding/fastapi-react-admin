"""渠道层：只管「把一条送出去」，返回分过类的结果，永远不抛（#166 第五节）。

分类决定 worker 怎么处理这一行：

| 结果 | 处理 |
|---|---|
| `sent` | 成功 |
| `retryable` | 没发出去 / 对方暂时不收：按退避再试 |
| `permanent` | 收件人不存在、配置错了、余额没了 —— 再试也一样：直接 exhausted |
| `unknown` | 🔴 可能已经发出去了：**不重试**（重试就是重复发） |

短信插件的 `SmsErrorKind` 已经把「没连上」和「连上之后出事」分开了（`plugin/sms/AGENTS.md` 第一张表），这里照它分；
邮件那边 `send_email` 把一切包成 `GatewayError`，原始异常在 `__cause__` 上。
"""

from __future__ import annotations

import enum
import time

from dataclasses import dataclass
from typing import TYPE_CHECKING

from backend.common.log import log
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.plugin.notification.enums import NotificationChannel

if TYPE_CHECKING:
    from backend.plugin.notification.kinds import NotificationKind
    from backend.plugin.notification.model import NotificationDelivery


class Outcome(enum.Enum):
    sent = 'sent'
    retryable = 'retryable'
    permanent = 'permanent'
    unknown = 'unknown'


@dataclass(frozen=True, slots=True)
class SendResult:
    outcome: Outcome
    error: str | None = None
    #: 失败分类，进 `reason` 列（投递记录页按它显示）
    reason: str | None = None
    ref: str | None = None
    duration_ms: int = 0


def absolute_link(link: str | None) -> str | None:
    """站内的 `link` 是前端路由（`/workflow/inbox?id=…`），邮件里要绝对地址"""
    if not link:
        return None
    if link.startswith(('http://', 'https://')):
        return link
    return f'{settings.NOTIFICATION_WEB_BASE_URL.rstrip("/")}/{link.lstrip("/")}'


def classify_smtp_error(exc: BaseException) -> tuple[Outcome, str]:
    """按 aiosmtplib 的原始异常分类（`send_email` 抛的 GatewayError 的 `__cause__`）"""
    import aiosmtplib

    if isinstance(exc, aiosmtplib.SMTPRecipientsRefused):
        return Outcome.permanent, 'recipient_refused'
    if isinstance(exc, aiosmtplib.SMTPResponseException):
        # 5xx 永久（550 收件人不存在 / 535 认证失败 / 553 地址非法）；4xx 是对方的临时状态（421 / 450 / 451）
        if exc.code >= 500:
            return Outcome.permanent, 'smtp_rejected' if exc.code != 535 else 'config_error'
        return Outcome.retryable, 'smtp_busy'
    if isinstance(exc, (aiosmtplib.SMTPConnectError, aiosmtplib.SMTPTimeoutError, OSError, TimeoutError)):
        # 连不上 / 超时 / 断开都重试。邮件和短信不一样：重复一封邮件的代价远小于漏一条催办
        return Outcome.retryable, 'network'
    return Outcome.retryable, 'unexpected'


async def send_email(row: NotificationDelivery) -> SendResult:
    from backend.common.exception import errors
    from backend.plugin.email.utils.send import send_email as smtp_send

    started = time.monotonic()
    try:
        async with async_db_session() as db:
            await smtp_send(
                db,
                [row.address or ''],
                row.title,
                {'title': row.title, 'content': row.content, 'link': absolute_link(row.link)},
                'notification.html',
            )
    except errors.GatewayError as e:
        outcome, reason = classify_smtp_error(e.__cause__ or e)
        return SendResult(outcome, f'{e.__cause__ or e}'[:2000], reason, None, _ms(started))
    except Exception as e:
        log.error(f'通知邮件 {row.id} 发送时出现意外异常：{e!r}')
        return SendResult(Outcome.retryable, repr(e)[:2000], 'unexpected', None, _ms(started))
    return SendResult(Outcome.sent, None, None, None, _ms(started))


#: 短信插件的错误类型 → 处理。不在表里的（将来加的）按「可重试」兜底 —— 不确定时宁可再试一次也别直接放弃
_SMS_OUTCOME: dict[str, Outcome] = {
    'unknown': Outcome.unknown,
    'network_unsent': Outcome.retryable,
    'provider_error': Outcome.retryable,
    'rate_limited': Outcome.retryable,
    'circuit_open': Outcome.retryable,
    'invalid_phone': Outcome.permanent,
    'bad_params': Outcome.permanent,
    'config_error': Outcome.permanent,
    'account_error': Outcome.permanent,
}


async def send_sms(row: NotificationDelivery, kind: NotificationKind) -> SendResult:
    from backend.plugin.sms.errors import SmsSendError
    from backend.plugin.sms.service.sms_service import sms_service

    started = time.monotonic()
    if not kind.sms_template or kind.sms_params is None:
        # 注册表那一层已经拦过；走到这里说明类型定义在投递行写下之后被改了
        return SendResult(Outcome.permanent, f'通知类型 {kind.code} 不再支持短信', 'kind_changed', None, _ms(started))
    try:
        result = await sms_service.send(
            phone=row.address or '',
            template=kind.sms_template,
            params=dict(kind.sms_params(row.title, row.content)),
        )
    except SmsSendError as e:
        outcome = _SMS_OUTCOME.get(e.kind, Outcome.retryable)
        ref = str(e.log_id) if e.log_id is not None else None
        return SendResult(outcome, e.msg[:2000], e.kind, ref, _ms(started))
    except Exception as e:
        # 业务模板没注册 / 参数对不上：使用方的 bug，再试也一样
        log.error(f'通知短信 {row.id} 发送时出现意外异常：{e!r}')
        return SendResult(Outcome.permanent, repr(e)[:2000], 'unexpected', None, _ms(started))
    return SendResult(Outcome.sent, None, None, result.log_id, _ms(started))


async def send(row: NotificationDelivery, kind: NotificationKind) -> SendResult:
    """按渠道分发。永远返回，永远不抛"""
    try:
        if row.channel == NotificationChannel.email.value:
            return await send_email(row)
        if row.channel == NotificationChannel.sms.value:
            return await send_sms(row, kind)
    except Exception as e:  # 上面两个已经自己兜住了，这里是最后一道
        return SendResult(Outcome.retryable, repr(e)[:2000], 'unexpected')
    return SendResult(Outcome.permanent, f'不认识的渠道 {row.channel}', 'unknown_channel')


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
