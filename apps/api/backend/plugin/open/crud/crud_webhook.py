"""Webhook 四张表的数据库操作（#167）"""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.open.enums import WebhookDeliveryStatus
from backend.plugin.open.model import OpenApp, OpenEvent, OpenWebhook, OpenWebhookAttempt, OpenWebhookDelivery
from backend.utils.timezone import timezone

_RETRYABLE = (WebhookDeliveryStatus.failed.value, WebhookDeliveryStatus.exhausted.value)


class CRUDOpenWebhook(DataScopedCRUD[OpenWebhook]):
    """Webhook 端点的数据库操作类"""

    # 挂在应用下的系统级配置（同应用本身），访问控制靠 `open:webhook:*` 权限码
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> OpenWebhook | None:
        return await self.select_model(db, pk)

    async def get_by_app(self, db: AsyncSession, app_id: int) -> Sequence[OpenWebhook]:
        stmt = select(OpenWebhook).where(OpenWebhook.app_id == app_id).order_by(OpenWebhook.id)
        return (await db.scalars(stmt)).all()

    async def count_by_app(self, db: AsyncSession, app_id: int) -> int:
        return await db.scalar(select(func.count()).select_from(OpenWebhook).where(OpenWebhook.app_id == app_id)) or 0

    async def subscribers(self, db: AsyncSession) -> Sequence[tuple[OpenWebhook, OpenApp]]:
        """所有**可能**收事件的端点（端点正常 + 应用正常且没删）。订阅 / scope / 过期在 Python 里判

        端点总数是「每个应用最多十个」量级，一次取出来比把通配匹配写成 SQL 简单，也不用三个方言各写一份 LIKE 转义
        """
        stmt = (
            select(OpenWebhook, OpenApp)
            .join(OpenApp, OpenApp.id == OpenWebhook.app_id)
            .where(OpenWebhook.status == 1, OpenApp.status == 1, OpenApp.deleted == 0)
        )
        return [(w, a) for w, a in (await db.execute(stmt)).all()]

    async def delete_with_history(self, db: AsyncSession, pk: int) -> int:
        """删端点连带它的投递和尝试记录（硬删：端点没了，这些记录也没处看）"""
        delivery_ids = select(OpenWebhookDelivery.id).where(OpenWebhookDelivery.webhook_id == pk)
        await db.execute(delete(OpenWebhookAttempt).where(OpenWebhookAttempt.delivery_id.in_(delivery_ids)))
        await db.execute(delete(OpenWebhookDelivery).where(OpenWebhookDelivery.webhook_id == pk))
        result = await db.execute(delete(OpenWebhook).where(OpenWebhook.id == pk))
        return result.rowcount or 0


class CRUDOpenEvent(DataScopedCRUD[OpenEvent]):
    """Webhook 事件的数据库操作类"""

    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> OpenEvent | None:
        return await self.select_model(db, pk)


class CRUDOpenWebhookDelivery(DataScopedCRUD[OpenWebhookDelivery]):
    """Webhook 投递的数据库操作类"""

    # 审计记录（同调用日志），访问控制靠 `open:webhook:list`
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> OpenWebhookDelivery | None:
        return await self.select_model(db, pk)

    def get_select(
        self,
        *,
        app_id: int | None = None,
        webhook_id: int | None = None,
        event_type: str | None = None,
        status: str | None = None,
    ) -> Select:
        """列表：带上端点名称（端点删了，它的投递记录也一起删了，所以 inner join 不会漏行）"""
        stmt = (
            select(
                OpenWebhookDelivery.id,
                OpenWebhookDelivery.webhook_id,
                OpenWebhook.name.label('webhook_name'),
                OpenWebhookDelivery.event_id,
                OpenWebhookDelivery.event_type,
                OpenWebhookDelivery.status,
                OpenWebhookDelivery.attempts,
                OpenWebhookDelivery.next_attempt_time,
                OpenWebhookDelivery.last_response_code,
                OpenWebhookDelivery.last_error,
                OpenWebhookDelivery.last_duration_ms,
                OpenWebhookDelivery.success_time,
                OpenWebhookDelivery.created_time,
                OpenWebhookDelivery.updated_time,
            )
            .join(OpenWebhook, OpenWebhook.id == OpenWebhookDelivery.webhook_id)
            .order_by(OpenWebhookDelivery.id.desc())
        )
        if app_id is not None:
            stmt = stmt.where(OpenWebhook.app_id == app_id)
        if webhook_id is not None:
            stmt = stmt.where(OpenWebhookDelivery.webhook_id == webhook_id)
        if event_type:
            stmt = stmt.where(OpenWebhookDelivery.event_type == event_type)
        if status:
            stmt = stmt.where(OpenWebhookDelivery.status == status)
        return stmt

    async def attempts_of(self, db: AsyncSession, pk: int) -> Sequence[OpenWebhookAttempt]:
        stmt = select(OpenWebhookAttempt).where(OpenWebhookAttempt.delivery_id == pk).order_by(OpenWebhookAttempt.id)
        return (await db.scalars(stmt)).all()

    async def due_ids(self, db: AsyncSession, *, after_id: int, limit: int, now: datetime) -> list[int]:
        """到点该发的一批（同通知投递）：按 id 往后翻，不每轮从头取"""
        stmt = (
            select(OpenWebhookDelivery.id)
            .where(
                OpenWebhookDelivery.id > after_id,
                or_(
                    OpenWebhookDelivery.status == WebhookDeliveryStatus.pending.value,
                    and_(
                        OpenWebhookDelivery.status == WebhookDeliveryStatus.failed.value,
                        OpenWebhookDelivery.next_attempt_time <= now,
                    ),
                ),
            )
            .order_by(OpenWebhookDelivery.id)
            .limit(limit)
        )
        return list((await db.scalars(stmt)).all())

    async def claim(self, db: AsyncSession, pk: int, *, any_retryable: bool = False) -> bool:
        """抢占一行：判据是这一条 UPDATE 的 rowcount（同通知投递的 `claim`）。

        `any_retryable=True` 给「发测试事件 / 手动重发后立刻发一次」用：不等 `next_attempt_time`
        """
        now = timezone.now()
        ready = OpenWebhookDelivery.status == WebhookDeliveryStatus.pending.value
        if any_retryable:
            ready = or_(ready, OpenWebhookDelivery.status == WebhookDeliveryStatus.failed.value)
        else:
            ready = or_(
                ready,
                and_(
                    OpenWebhookDelivery.status == WebhookDeliveryStatus.failed.value,
                    OpenWebhookDelivery.next_attempt_time <= now,
                ),
            )
        result = await db.execute(
            update(OpenWebhookDelivery)
            .where(OpenWebhookDelivery.id == pk, ready)
            .values(status=WebhookDeliveryStatus.sending.value, updated_time=now)
        )
        return (result.rowcount or 0) == 1

    async def settle(self, db: AsyncSession, pk: int, **values: object) -> int:
        result = await db.execute(
            update(OpenWebhookDelivery)
            .where(OpenWebhookDelivery.id == pk)
            .values(updated_time=timezone.now(), **values)
        )
        return result.rowcount or 0

    async def reclaim_stale(self, db: AsyncSession, *, before: datetime) -> int:
        """停在「发送中」太久的行（worker 发到一半被杀）→ 失败、马上重试。

        ⚠️ 和通知那边**相反**（那边归成「结果未知」不重发）：Webhook 是至少一次，对方按 `webhook-id` 去重
        """
        now = timezone.now()
        result = await db.execute(
            update(OpenWebhookDelivery)
            .where(
                OpenWebhookDelivery.status == WebhookDeliveryStatus.sending.value,
                OpenWebhookDelivery.updated_time < before,
            )
            .values(
                status=WebhookDeliveryStatus.failed.value,
                last_error='stale: worker 在发送中退出',
                next_attempt_time=now,
                updated_time=now,
            )
        )
        return result.rowcount or 0

    async def resend(self, db: AsyncSession, pk: int) -> int:
        """手动重发一条：失败 / 用完重试的行改回待发，次数清零重新计"""
        result = await db.execute(
            update(OpenWebhookDelivery)
            .where(OpenWebhookDelivery.id == pk, OpenWebhookDelivery.status.in_(_RETRYABLE))
            .values(
                status=WebhookDeliveryStatus.pending.value,
                attempts=0,
                next_attempt_time=None,
                updated_time=timezone.now(),
            )
        )
        return result.rowcount or 0

    async def resend_exhausted(self, db: AsyncSession, *, webhook_id: int, since: datetime) -> int:
        """批量恢复：某个端点在 `since` 之后产生、已经放弃的投递全部改回待发（端点修好之后用）"""
        result = await db.execute(
            update(OpenWebhookDelivery)
            .where(
                OpenWebhookDelivery.webhook_id == webhook_id,
                OpenWebhookDelivery.status == WebhookDeliveryStatus.exhausted.value,
                OpenWebhookDelivery.created_time >= since,
            )
            .values(
                status=WebhookDeliveryStatus.pending.value,
                attempts=0,
                next_attempt_time=None,
                updated_time=timezone.now(),
            )
        )
        return result.rowcount or 0


open_webhook_dao: CRUDOpenWebhook = CRUDOpenWebhook(OpenWebhook)
open_event_dao: CRUDOpenEvent = CRUDOpenEvent(OpenEvent)
open_webhook_delivery_dao: CRUDOpenWebhookDelivery = CRUDOpenWebhookDelivery(OpenWebhookDelivery)
