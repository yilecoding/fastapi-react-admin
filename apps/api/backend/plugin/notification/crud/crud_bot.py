"""群机器人的数据库操作（#166 二期）"""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notification.enums import DeliveryStatus, NotificationChannel
from backend.plugin.notification.model import NotificationBot, NotificationDelivery
from backend.utils.timezone import timezone


class CRUDNotificationBot(DataScopedCRUD[NotificationBot]):
    """群机器人的数据库操作类"""

    # 全局配置，不属于任何部门；访问控制由 `sys:notification:bot:*` 权限码负责
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> NotificationBot | None:
        return await self.select_model(db, pk)

    async def get_all(self, db: AsyncSession) -> Sequence[NotificationBot]:
        return (await db.scalars(select(NotificationBot).order_by(NotificationBot.id))).all()

    async def get_enabled(self, db: AsyncSession) -> Sequence[NotificationBot]:
        """启用的全部机器人。订阅关系是 JSON 列，按类型筛在 Python 里做 —— 机器人是个位数的配置，不值得一张关联表"""
        return (
            await db.scalars(select(NotificationBot).where(NotificationBot.status == 1).order_by(NotificationBot.id))
        ).all()

    async def record_result(self, db: AsyncSession, pk: int, *, ok: bool, error: str | None) -> None:
        """记最近一次的结果，卡片上看得到「上次成功是什么时候 / 最近为什么失败」"""
        values: dict[str, object] = {'last_error': None if ok else (error or '')[:2000]}
        if ok:
            values['last_sent_time'] = timezone.now()
        await db.execute(update(NotificationBot).where(NotificationBot.id == pk).values(**values))

    async def recent_sends(self, db: AsyncSession, pk: int, *, since: datetime, exclude_id: int) -> int:
        """这个机器人从 `since` 起发出去了几条（含别的 worker 正在发的）—— 发之前自己数，别撞平台的频率上限。

        `exclude_id` 是调用方自己刚抢到的那一行：它已经是「发送中」了，不排除就把自己也数进去
        """
        stmt = select(func.count()).where(
            NotificationDelivery.bot_id == pk,
            NotificationDelivery.id != exclude_id,
            NotificationDelivery.channel == NotificationChannel.bot.value,
            ((NotificationDelivery.status == DeliveryStatus.sent.value) & (NotificationDelivery.sent_time >= since))
            | (
                (NotificationDelivery.status == DeliveryStatus.sending.value)
                & (NotificationDelivery.updated_time >= since)
            ),
        )
        return int(await db.scalar(stmt) or 0)


notification_bot_dao: CRUDNotificationBot = CRUDNotificationBot(NotificationBot)
