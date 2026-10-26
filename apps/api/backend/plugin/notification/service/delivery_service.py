"""投递层：事务内 outbox + worker 异步发 + 退避重试 + 手动重发（#166 第四节）。

```
调用方事务 ── 写站内行 ── enqueue()（同一事务写投递行） ── commit ── kick()（踢一脚 worker，正常路径秒级）
                                                                      │
Celery `notification.deliver_pending`（每 15 秒的安全网 + 被踢）──────┘
    reclaim_stale → 按 id 往后翻一批 → claim（UPDATE … WHERE status 待发，看 rowcount）→ 发 → settle
```

- 🔴 **投递行和站内行在同一个事务里写。** 业务回滚就一起没了，不会出现「审批没成、邮件先到」——
  短信分册「`send()` 不参与调用方事务，要在提交之后再发」说的就是这个风险，outbox 把它变成结构保证
- 🔴 **重试状态在表里，不在 broker 里。** 不用 `apply_async(countdown=…)` 一条一个任务：那要处理 revoke / 改期 /
  worker 重启后 eta 任务的归属（`tasks/maintenance/tasks.py` 顶部那段）；扫表幂等、漏跑一轮下一轮补上
- 🔴 **「结果未知」不重试**，停在 sending 太久的行也归「结果未知」而不是改回 pending
"""

from __future__ import annotations

import asyncio

from datetime import timedelta
from typing import TYPE_CHECKING, Any

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.plugin.notification.crud.crud_channel import notification_delivery_dao
from backend.plugin.notification.enums import DeliveryStatus
from backend.plugin.notification.kinds import NotificationKind, get_notification_kind
from backend.plugin.notification.model import NotificationDelivery
from backend.plugin.notification.service.senders import Outcome, send
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from sqlalchemy.ext.asyncio import AsyncSession

    from backend.plugin.notification.service.routing import Route

TASK_NAME = 'notification.deliver_pending'


def backoff_schedule() -> list[int]:
    """退避秒数。配置是逗号分隔的串；写坏了回落默认值，不让一次手滑停掉全部重试"""
    try:
        values = [int(x) for x in str(settings.NOTIFICATION_RETRY_BACKOFF_SECONDS).split(',') if x.strip()]
    except ValueError:
        values = []
    if not values or any(v <= 0 for v in values):
        log.error(
            f'NOTIFICATION_RETRY_BACKOFF_SECONDS 配置无效：{settings.NOTIFICATION_RETRY_BACKOFF_SECONDS!r}，用默认值'
        )
        values = [60, 300, 1800, 7200]
    return values


def next_delay(attempts: int) -> int:
    """第 `attempts` 次失败之后等多久（attempts 从 1 起）。次数比表长就用最后一档"""
    schedule = backoff_schedule()
    return schedule[min(attempts, len(schedule)) - 1]


def enqueue(
    db: AsyncSession,
    *,
    kind: NotificationKind,
    routes: Sequence[Route],
    title: str,
    content: str,
    link: str | None,
    notification_ids: Mapping[int, int] | None = None,
) -> int:
    """在调用方的事务里写投递行，返回待发的行数（> 0 时调用方提交后要 `kick()`）。不 commit、不 flush"""
    pending = 0
    for route in routes:
        status = DeliveryStatus.skipped if route.reason else DeliveryStatus.pending
        db.add(
            NotificationDelivery(
                notification_id=(notification_ids or {}).get(route.user_id),
                user_id=route.user_id,
                kind=kind.code,
                channel=route.channel.value,
                address=route.address,
                title=title[:128],
                content=content,
                link=link,
                status=status.value,
                reason=route.reason,
            )
        )
        pending += status is DeliveryStatus.pending
    return pending


async def kick() -> None:
    """提交之后踢一脚 worker。丢不出去只记 warning：每 15 秒的周期调度会补上，这里只是让正常路径更快"""
    try:
        from backend.app.task.celery import celery_app

        # send_task 是同步的（要连 broker），别卡住事件循环；retry=False：broker 不通时立刻失败，不在这里等
        await asyncio.to_thread(celery_app.send_task, TASK_NAME, retry=False)
    except Exception as e:
        log.warning(f'通知投递任务派发失败（周期调度会补上）：{e!s}')


async def _deliver_one(pk: int) -> str | None:
    """抢一行、发、落终态。返回这一行的新状态（没抢到返回 None）"""
    async with async_db_session.begin() as db:
        if not await notification_delivery_dao.claim(db, pk):
            return None
    async with async_db_session() as db:
        row = await notification_delivery_dao.get(db, pk)
    if row is None:
        return None

    kind = get_notification_kind(row.kind)
    if kind is None:
        values: dict[str, Any] = {
            'status': DeliveryStatus.exhausted.value,
            'reason': 'kind_missing',
            'last_error': f'通知类型 {row.kind} 已不存在',
            'next_attempt_time': None,
        }
    else:
        result = await send(row, kind)
        attempts = row.attempts + 1
        values = {
            'attempts': attempts,
            'duration_ms': result.duration_ms,
            'provider_ref': result.ref,
            'reason': result.reason,
            'last_error': result.error,
            'next_attempt_time': None,
        }
        if result.outcome is Outcome.sent:
            values |= {'status': DeliveryStatus.sent.value, 'sent_time': timezone.now(), 'last_error': None}
        elif result.outcome is Outcome.unknown:
            values['status'] = DeliveryStatus.unknown.value
        elif result.outcome is Outcome.permanent or attempts > settings.NOTIFICATION_RETRY_MAX:
            values['status'] = DeliveryStatus.exhausted.value
        else:
            values |= {
                'status': DeliveryStatus.failed.value,
                'next_attempt_time': timezone.now() + timedelta(seconds=next_delay(attempts)),
            }
    try:
        async with async_db_session.begin() as db:
            await notification_delivery_dao.settle(db, pk, **values)
    except Exception as e:
        # 发出去了但终态没落库：那一行停在 sending，超时后由 reclaim_stale 归成「结果未知」—— 不会被重发
        log.error(f'通知投递 {pk} 更新终态失败（{values.get("status")}）：{e!s}')
    return values['status']


async def deliver_pending() -> dict[str, int]:
    """worker 入口：处理到点的全部投递，返回各状态计数"""
    from backend.plugin.notification.extensions import load_notification_extensions
    from backend.plugin.notification.service.config import load_notification_config

    load_notification_extensions()
    async with async_db_session() as db:
        await load_notification_config(db)

    stats: dict[str, int] = {}
    async with async_db_session.begin() as db:
        stale = await notification_delivery_dao.reclaim_stale(
            db, before=timezone.now() - timedelta(seconds=settings.NOTIFICATION_SENDING_STALE_SECONDS)
        )
    if stale:
        stats['stale'] = stale
        log.warning(
            f'通知投递：{stale} 行停在「发送中」超过 {settings.NOTIFICATION_SENDING_STALE_SECONDS} 秒，已归为结果未知'
        )

    last_id = 0
    batch = max(1, settings.NOTIFICATION_DELIVERY_BATCH)
    while True:
        async with async_db_session() as db:
            ids = await notification_delivery_dao.due_ids(db, after_id=last_id, limit=batch, now=timezone.now())
        if not ids:
            break
        for pk in ids:
            status = await _deliver_one(pk)
            key = status or 'skipped_by_other_worker'
            stats[key] = stats.get(key, 0) + 1
        last_id = ids[-1]
        if len(ids) < batch:
            break
    return stats


class DeliveryService:
    """投递记录的查询与手动重发（管理端）"""

    @staticmethod
    async def get_list(db: AsyncSession, **filters: Any) -> dict[str, Any]:
        select = await notification_delivery_dao.get_select(**filters)
        page = await paging_data(db, select)
        for item in page['items']:
            item['address'] = mask_address(item.get('channel'), item.get('address'))
        return page

    @staticmethod
    async def get(db: AsyncSession, pk: int) -> NotificationDelivery:
        row = await notification_delivery_dao.get(db, pk)
        if row is None:
            raise errors.NotFoundError(msg=t('error.notification.delivery_not_found'))
        return row

    @staticmethod
    async def resend(db: AsyncSession, pk: int) -> None:
        row = await notification_delivery_dao.get(db, pk)
        if row is None:
            raise errors.NotFoundError(msg=t('error.notification.delivery_not_found'))
        if not await notification_delivery_dao.resend(db, pk):
            # 已发 / 发送中 / 待发 / skipped（没地址重发也没用，先去补地址）都不能重发
            raise errors.ConflictError(msg=t('error.notification.delivery_not_resendable'))


def mask_address(channel: str | None, address: str | None) -> str | None:
    """列表接口掩码：手机号 138****0000，邮箱 a***@example.com。详情接口给完整值（同短信日志）"""
    if not address:
        return address
    if channel == 'sms' and len(address) >= 7:
        return f'{address[:3]}****{address[-4:]}'
    if channel == 'email' and '@' in address:
        name, domain = address.split('@', 1)
        return f'{name[:1]}***@{domain}'
    return address


delivery_service: DeliveryService = DeliveryService()
