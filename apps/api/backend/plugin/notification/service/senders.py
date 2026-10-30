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
群机器人（#166 二期）同短信：连接没建立 = 没发出去，重试；请求发出去之后超时 / 断开 = 可能已经进群了，结果未知、不重试
（群里一条消息出现两次，比邮件重复显眼得多）。
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
    import httpx

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


#: 测试用：换成 `httpx.MockTransport`。生产永远是 None（走真实网络）
bot_transport: httpx.AsyncBaseTransport | None = None

_BOT_OUTCOME: dict[str, Outcome] = {
    'sent': Outcome.sent,
    'retryable': Outcome.retryable,
    'permanent': Outcome.permanent,
    'unknown': Outcome.unknown,
}


async def post_bot(
    platform: str, url: str, secret: str | None, *, title: str, content: str, link: str | None
) -> SendResult:
    """往一个群机器人发一条。投递 worker 和「发测试消息」共用；永远返回，永远不抛"""
    import httpx

    from backend.common.i18n import t
    from backend.plugin.notification.bot_platforms import build_request, classify

    started = time.monotonic()
    try:
        req = build_request(
            platform,
            url,
            secret=secret,
            title=title,
            content=content,
            link=absolute_link(link),
            link_label=t('notification.bot.view_detail'),
            now=time.time(),
        )
    except Exception as e:
        return SendResult(Outcome.permanent, repr(e)[:2000], 'config_error', None, _ms(started))
    try:
        # 不跟随重定向：官方接口不会 30x，跟过去就是去了一个没校验过的地址
        async with httpx.AsyncClient(
            timeout=settings.NOTIFICATION_BOT_TIMEOUT_SECONDS, follow_redirects=False, transport=bot_transport
        ) as client:
            resp = await client.post(req.url, content=req.body, headers={'content-type': 'application/json'})
    except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as e:
        # 连接没建立：一个字节都没发出去
        return SendResult(Outcome.retryable, f'{type(e).__name__}: {e!s}'[:2000], 'network', None, _ms(started))
    except httpx.HTTPError as e:
        # 请求已经发出去了（读超时 / 对方断开）：可能已经进群了
        return SendResult(
            Outcome.unknown, f'{type(e).__name__}: {e!s}'[:2000], 'network_after_send', None, _ms(started)
        )
    except Exception as e:
        log.error(f'群机器人发送时出现意外异常：{e!r}')
        return SendResult(Outcome.retryable, repr(e)[:2000], 'unexpected', None, _ms(started))
    verdict, reason, error = classify(platform, resp.status_code, resp.content)
    return SendResult(_BOT_OUTCOME[verdict], error, reason, None, _ms(started))


async def send_bot(row: NotificationDelivery) -> SendResult:
    from backend.plugin.notification.crud.crud_bot import notification_bot_dao
    from backend.plugin.notification.service.bot_service import decrypt

    started = time.monotonic()
    async with async_db_session() as db:
        bot = await notification_bot_dao.get(db, row.bot_id) if row.bot_id is not None else None
    if bot is None:
        return SendResult(Outcome.permanent, '机器人已删除', 'bot_missing', None, _ms(started))
    if bot.status != 1:
        return SendResult(Outcome.permanent, '机器人已停用', 'bot_disabled', None, _ms(started))
    try:
        url = decrypt(bot.webhook_cipher)
        secret = decrypt(bot.secret_cipher) if bot.secret_cipher else None
    except Exception as e:
        # 加密密钥换过 / 没配：再试也一样
        return SendResult(Outcome.permanent, repr(e)[:2000], 'config_error', None, _ms(started))
    return await post_bot(bot.platform, url, secret, title=row.title, content=row.content, link=row.link)


async def send(row: NotificationDelivery, kind: NotificationKind) -> SendResult:
    """按渠道分发。永远返回，永远不抛"""
    try:
        if row.channel == NotificationChannel.email.value:
            return await send_email(row)
        if row.channel == NotificationChannel.sms.value:
            return await send_sms(row, kind)
        if row.channel == NotificationChannel.bot.value:
            return await send_bot(row)
    except Exception as e:  # 上面三个已经自己兜住了，这里是最后一道
        return SendResult(Outcome.retryable, repr(e)[:2000], 'unexpected')
    return SendResult(Outcome.permanent, f'不认识的渠道 {row.channel}', 'unknown_channel')


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
