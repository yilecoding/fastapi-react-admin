"""受众表的数据库操作（#190）"""

from collections.abc import Sequence

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notification.audience import normalize_audience
from backend.plugin.notification.model import NotificationAudience


class CRUDNotificationAudience(DataScopedCRUD[NotificationAudience]):
    """受众表数据库操作类"""

    # 受众行是来源对象（公告）的一部分，不属于任何部门；读它是为了判「这个人看不看得见」，
    # 叠一层数据权限等于让受限用户连发给自己的公告都看不见（common/security 分册「非展示的读」）
    data_scope_enabled = False

    async def get_by_sources(self, db: AsyncSession, sources: Sequence[str]) -> dict[str, list[tuple[str, int]]]:
        """
        一批来源各自的受众（按写入顺序）。没有受众的来源不出现在结果里

        :param db: 数据库会话
        :param sources: 来源列表
        :return:
        """
        if not sources:
            return {}
        stmt = (
            select(NotificationAudience.source, NotificationAudience.kind, NotificationAudience.target_id)
            .where(NotificationAudience.source.in_(list(dict.fromkeys(sources))))
            .order_by(NotificationAudience.id)
        )
        out: dict[str, list[tuple[str, int]]] = {}
        for source, kind, target_id in (await db.execute(stmt)).all():
            out.setdefault(source, []).append((kind, target_id))
        return out

    async def replace(self, db: AsyncSession, source: str, entries: Sequence[tuple[str, int]]) -> None:
        """
        把一个来源的受众换成 `entries`（空 = 全员）。删了重写，在调用方的事务里

        :param db: 数据库会话
        :param source: 来源
        :param entries: (kind, target_id) 列表
        :return:
        """
        await self.delete_by_source(db, source)
        rows = normalize_audience(entries)
        if rows:
            # 走 ORM 实例：雪花主键的默认值挂在映射上，core 批量插入拿不到
            db.add_all([
                NotificationAudience(source=source, kind=kind, target_id=target_id) for kind, target_id in rows
            ])
            await db.flush()

    async def delete_by_source(self, db: AsyncSession, source: str) -> int:
        """
        删掉一个来源的全部受众行（硬删）

        :param db: 数据库会话
        :param source: 来源
        :return:
        """
        result = await db.execute(delete(NotificationAudience).where(NotificationAudience.source == source))
        return result.rowcount or 0


notification_audience_dao: CRUDNotificationAudience = CRUDNotificationAudience(NotificationAudience)
