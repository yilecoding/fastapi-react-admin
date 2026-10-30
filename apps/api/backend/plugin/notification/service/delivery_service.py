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

from sqlalchemy import event as sa_event

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.database.db import async_db_session
from backend.plugin.notification.crud.crud_channel import notification_delivery_dao
from backend.plugin.notification.enums import DeliveryStatus, NotificationChannel
from backend.plugin.notification.kinds import NotificationKind, get_notification_kind
from backend.plugin.notification.model import NotificationDelivery
from backend.plugin.notification.service.senders import Outcome, send
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from sqlalchemy.ext.asyncio import AsyncSession
    from sqlalchemy.orm import Session

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


_KICK_FLAG = 'notification_kick_after_commit'
_LISTENING = 'notification_kick_listening'
#: 提交后派出去的 kick 协程：只靠 create_task 不留引用的话可能被 GC 回收掉
_background: set[asyncio.Task[None]] = set()


def kick_after_commit(db: AsyncSession) -> None:
    """提交之后踢一次 worker（给提交不在自己手里的调用方，如公告广播）。同一个会话只挂一次监听；回滚清掉标记"""
    sync: Session = db.sync_session
    sync.info[_KICK_FLAG] = True
    if sync.info.get(_LISTENING):
        return
    sync.info[_LISTENING] = True
    sa_event.listen(sync, 'after_commit', _after_commit)
    sa_event.listen(sync, 'after_rollback', _after_rollback)


def _after_commit(session: Session) -> None:
    if not session.info.pop(_KICK_FLAG, False):
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    task = loop.create_task(kick())
    _background.add(task)
    task.add_done_callback(_background.discard)


def _after_rollback(session: Session) -> None:
    session.info.pop(_KICK_FLAG, None)


async def _bot_throttled(pk: int, row: NotificationDelivery) -> int | None:
    """群机器人发之前自己数：这个机器人这一分钟 / 这一秒已经发了几条。超了返回要等的秒数。

    🔴 不数的话，一次批量审批（30 张单同时出结果）会让钉钉 / 企微第 21 条起全被拒（每个机器人 20 条/分钟），
    每条白白耗掉一次重试；据转载钉钉超限还会封一段时间。等到下一分钟再发，比撞上去再退避快得多
    """
    from backend.plugin.notification.bot_platforms import RATE_LIMITS
    from backend.plugin.notification.crud.crud_bot import notification_bot_dao

    if row.bot_id is None:
        return None
    async with async_db_session() as db:
        bot = await notification_bot_dao.get(db, row.bot_id)
        if bot is None or bot.platform not in RATE_LIMITS:
            return None
        per_minute, per_second = RATE_LIMITS[bot.platform]
        now = timezone.now()
        if (
            await notification_bot_dao.recent_sends(db, row.bot_id, since=now - timedelta(seconds=60), exclude_id=pk)
            >= per_minute
        ):
            return 60
        if (
            per_second
            and await notification_bot_dao.recent_sends(db, row.bot_id, since=now - timedelta(seconds=1), exclude_id=pk)
            >= per_second
        ):
            # 每秒的上限（飞书 5 次/秒）等一下就过去了，不值得把这一行推到下一轮
            await asyncio.sleep(1)
    return None


async def _defer_if_throttled(pk: int, row: NotificationDelivery) -> bool:
    """群机器人这一分钟发够了：推到下一分钟。不算一次尝试 —— 没发出去是我们自己挡的，不是对方拒的"""
    if row.channel != NotificationChannel.bot.value:
        return False
    try:
        wait = await _bot_throttled(pk, row)
    except Exception as e:
        # 🔴 这一行已经抢成 sending 了：在这里抛出去，它就停在 sending、过一会儿被归成「结果未知」，一条没发也不会再发。
        # 数不出来就照发 —— 真超了平台会拒，按重试走
        log.warning(f'通知投递 {pk} 限流计数失败，照发：{e!s}')
        return False
    if wait is None:
        return False
    async with async_db_session.begin() as db:
        await notification_delivery_dao.settle(
            db,
            pk,
            status=DeliveryStatus.failed.value,
            reason='throttled',
            next_attempt_time=timezone.now() + timedelta(seconds=wait),
        )
    return True


async def _attempt(row: NotificationDelivery) -> dict[str, Any]:
    """发一次，算出这一行的终态（要写回的列）"""
    kind = get_notification_kind(row.kind)
    if kind is None:
        return {
            'status': DeliveryStatus.exhausted.value,
            'reason': 'kind_missing',
            'last_error': f'通知类型 {row.kind} 已不存在',
            'next_attempt_time': None,
        }
    result = await send(row, kind)
    attempts = row.attempts + 1
    values: dict[str, Any] = {
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
    return values


async def _deliver_one(pk: int) -> str | None:
    """抢一行、发、落终态。返回这一行的新状态（没抢到返回 None）"""
    async with async_db_session.begin() as db:
        if not await notification_delivery_dao.claim(db, pk):
            return None
    async with async_db_session() as db:
        row = await notification_delivery_dao.get(db, pk)
    if row is None:
        return None
    if await _defer_if_throttled(pk, row):
        return 'throttled'

    values = await _attempt(row)
    try:
        async with async_db_session.begin() as db:
            await notification_delivery_dao.settle(db, pk, **values)
    except Exception as e:
        # 发出去了但终态没落库：那一行停在 sending，超时后由 reclaim_stale 归成「结果未知」—— 不会被重发
        log.error(f'通知投递 {pk} 更新终态失败（{values.get("status")}）：{e!s}')
        return values['status']
    if row.bot_id is not None and values['status'] != DeliveryStatus.failed.value:
        await _record_bot_result(row.bot_id, values)
    return values['status']


async def _record_bot_result(bot_id: int, values: dict[str, Any]) -> None:
    """机器人卡片上的「最近成功 / 最近失败原因」。还会重试的失败不记：下一次可能就成了。

    🔴 单独一个事务：和终态放在一起的话，卡片这一步失败（行锁、机器人刚被删）会把已经进群的那一行一起回滚，
    停在 sending、过一会儿被归成「结果未知」
    """
    from backend.plugin.notification.crud.crud_bot import notification_bot_dao

    try:
        async with async_db_session.begin() as db:
            await notification_bot_dao.record_result(
                db, bot_id, ok=values['status'] == DeliveryStatus.sent.value, error=values.get('last_error')
            )
    except Exception as e:
        log.warning(f'群机器人 {bot_id} 更新最近结果失败：{e!s}')


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
    # 群机器人的 address 是机器人名称，不是凭据
    return address


delivery_service: DeliveryService = DeliveryService()
