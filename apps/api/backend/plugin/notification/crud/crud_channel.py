"""通知渠道路由三张表的数据库操作（#166）"""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import Select, and_, delete, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notification.enums import DeliveryStatus
from backend.plugin.notification.model import NotificationDelivery, NotificationPolicy, NotificationPref
from backend.utils.timezone import timezone


class CRUDNotificationPolicy(DataScopedCRUD[NotificationPolicy]):
    """通知渠道系统策略的数据库操作类"""

    # 全局配置，不属于任何部门；访问控制由 `sys:notification:policy:*` 权限码负责
    data_scope_enabled = False

    async def get_all(self, db: AsyncSession, kinds: Sequence[str] | None = None) -> Sequence[NotificationPolicy]:
        stmt = select(NotificationPolicy)
        if kinds is not None:
            stmt = stmt.where(NotificationPolicy.kind.in_(list(kinds)))
        return (await db.scalars(stmt)).all()

    async def upsert(self, db: AsyncSession, *, kind: str, channel: str, mode: str, user_id: int | None) -> None:
        """有行改、没行插。并发两个管理员同时保存同一格：后者撞唯一约束 → 500 而不是静默写错，可以接受"""
        row = await db.scalar(
            select(NotificationPolicy).where(NotificationPolicy.kind == kind, NotificationPolicy.channel == channel)
        )
        if row is None:
            db.add(NotificationPolicy(kind=kind, channel=channel, mode=mode, updated_by=user_id))
        else:
            row.mode = mode
            row.updated_by = user_id

    async def delete_cell(self, db: AsyncSession, *, kind: str, channel: str) -> int:
        """删一格 = 恢复注册表的默认值"""
        result = await db.execute(
            delete(NotificationPolicy).where(NotificationPolicy.kind == kind, NotificationPolicy.channel == channel)
        )
        return result.rowcount or 0


class CRUDNotificationPref(DataScopedCRUD[NotificationPref]):
    """通知渠道个人偏好的数据库操作类"""

    # 「我的偏好」，每条查询都强制按 `request.user.id` 过滤（同收件箱）
    data_scope_enabled = False

    async def get_for_users(
        self, db: AsyncSession, user_ids: Sequence[int], kind: str | None = None
    ) -> Sequence[NotificationPref]:
        if not user_ids:
            return []
        stmt = select(NotificationPref).where(NotificationPref.user_id.in_(list(user_ids)))
        if kind is not None:
            stmt = stmt.where(NotificationPref.kind == kind)
        return (await db.scalars(stmt)).all()

    async def upsert(self, db: AsyncSession, *, user_id: int, kind: str, channel: str, enabled: bool) -> None:
        row = await db.scalar(
            select(NotificationPref).where(
                NotificationPref.user_id == user_id, NotificationPref.kind == kind, NotificationPref.channel == channel
            )
        )
        if row is None:
            db.add(NotificationPref(user_id=user_id, kind=kind, channel=channel, enabled=enabled))
        else:
            row.enabled = enabled


class CRUDNotificationDelivery(DataScopedCRUD[NotificationDelivery]):
    """通知投递记录的数据库操作类"""

    # 审计记录（同短信发送日志 / 操作日志）：不按数据范围过滤，访问控制由 `sys:notification:delivery:*` 负责
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> NotificationDelivery | None:
        return await self.select_model(db, pk)

    async def get_select(
        self,
        *,
        kind: str | None = None,
        channel: str | None = None,
        status: str | None = None,
        user_id: int | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        """列表筛选。⚠️ 这里的关键字参数、接口的查询参数、接口往下传的那一行，三者要对齐（短信日志那条）"""
        kwargs: dict[str, object] = {}
        if kind:
            kwargs['kind'] = kind
        if channel:
            kwargs['channel'] = channel
        if status:
            kwargs['status'] = status
        if user_id is not None:
            kwargs['user_id'] = user_id
        if start_time is not None:
            kwargs['created_time__ge'] = start_time
        if end_time is not None:
            kwargs['created_time__le'] = end_time
        return await self.select_order('id', 'desc', **kwargs)

    async def due_ids(self, db: AsyncSession, *, after_id: int, limit: int, now: datetime) -> list[int]:
        """到点该发的一批：待发 / 失败待重试，按 id 往后翻（keyset）。

        🔴 不能每轮从头取：失败的行还匹配条件（下一次重试时间没到也可能被并发改回来），
        从头取会让一批永远卡在同几行上（`app/task/AGENTS.md`「写删除类任务的纪律」那条）。
        """
        stmt = (
            select(NotificationDelivery.id)
            .where(
                NotificationDelivery.id > after_id,
                or_(
                    NotificationDelivery.status == DeliveryStatus.pending.value,
                    and_(
                        NotificationDelivery.status == DeliveryStatus.failed.value,
                        NotificationDelivery.next_attempt_time <= now,
                    ),
                ),
            )
            .order_by(NotificationDelivery.id)
            .limit(limit)
        )
        return list((await db.scalars(stmt)).all())

    async def claim(self, db: AsyncSession, pk: int) -> bool:
        """抢占一行：只有把它从「待发 / 失败」改成「发送中」的那一个 worker 拿到它。

        🔴 判据是这一条 UPDATE 的 rowcount，不是先 SELECT 再看状态 —— 后者两个 worker 会同时看到 pending
        （同后台导出的「没抢到」）。条件里把 `next_attempt_time` 也带上：失败行在两次扫描之间被重发改回 pending 也能认。
        """
        now = timezone.now()
        result = await db.execute(
            update(NotificationDelivery)
            .where(
                NotificationDelivery.id == pk,
                or_(
                    NotificationDelivery.status == DeliveryStatus.pending.value,
                    and_(
                        NotificationDelivery.status == DeliveryStatus.failed.value,
                        NotificationDelivery.next_attempt_time <= now,
                    ),
                ),
            )
            .values(status=DeliveryStatus.sending.value, updated_time=now)
        )
        return (result.rowcount or 0) == 1

    async def settle(self, db: AsyncSession, pk: int, **values: object) -> int:
        result = await db.execute(
            update(NotificationDelivery)
            .where(NotificationDelivery.id == pk)
            .values(updated_time=timezone.now(), **values)
        )
        return result.rowcount or 0

    async def reclaim_stale(self, db: AsyncSession, *, before: datetime) -> int:
        """停在「发送中」太久的行（worker 在发到一半时被杀）→ 结果未知。

        🔴 不改回 pending 重发：它停在 sending 说明已经交给渠道了，可能已经发出去 —— 同短信日志的「发送中 → 结果未知」
        """
        result = await db.execute(
            update(NotificationDelivery)
            .where(
                NotificationDelivery.status == DeliveryStatus.sending.value,
                NotificationDelivery.updated_time < before,
            )
            .values(
                status=DeliveryStatus.unknown.value,
                reason='stale',
                next_attempt_time=None,
                updated_time=timezone.now(),
            )
        )
        return result.rowcount or 0

    async def resend(self, db: AsyncSession, pk: int) -> int:
        """手动重发：只对终态的失败行（用完重试 / 结果未知 / 失败待重试）有效。`attempts` 清零重新计"""
        result = await db.execute(
            update(NotificationDelivery)
            .where(
                NotificationDelivery.id == pk,
                NotificationDelivery.status.in_([
                    DeliveryStatus.exhausted.value,
                    DeliveryStatus.unknown.value,
                    DeliveryStatus.failed.value,
                ]),
            )
            .values(
                status=DeliveryStatus.pending.value,
                attempts=0,
                reason=None,
                next_attempt_time=None,
                updated_time=timezone.now(),
            )
        )
        return result.rowcount or 0


notification_policy_dao: CRUDNotificationPolicy = CRUDNotificationPolicy(NotificationPolicy)
notification_pref_dao: CRUDNotificationPref = CRUDNotificationPref(NotificationPref)
notification_delivery_dao: CRUDNotificationDelivery = CRUDNotificationDelivery(NotificationDelivery)
