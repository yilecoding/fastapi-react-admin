from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import ColumnElement, Select, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notification.model import Notification, NotificationRead
from backend.plugin.notification.schema.notification import CreateNotificationParam


def visible_to(user_id: int) -> ColumnElement[bool]:
    """「这个人能看见哪些通知」——广播（`recipient_id IS NULL`）或点名给他的

    单独抽出来是因为它出现在四个地方（列表 / 未读数 / 详情 / 全部已读），
    抄第二遍就会有人漏掉 `IS NULL` 那一半，而漏掉的表现是**公告一条都看不见**，
    不报错。
    """
    return or_(Notification.recipient_id.is_(None), Notification.recipient_id == user_id)


def _unread(user_id: int) -> ColumnElement[bool]:
    """未读 = `sys_notification_read` 里没有这个人对这条通知的行"""
    return (
        ~select(NotificationRead.id)
        .where(
            NotificationRead.notification_id == Notification.id,
            NotificationRead.user_id == user_id,
        )
        .exists()
    )


class CRUDNotification(DataScopedCRUD[Notification]):
    """站内通知数据库操作类"""

    # 收件箱是**按人**过滤的，不是按部门/角色的数据范围过滤。这里每一条查询都
    # 强制带上 `visible_to(current_user.id)`，再叠一层 fail-open 的数据权限只会
    # 让「我的通知」变成「我和我下属的通知」——语义直接错。
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> Notification | None:
        """
        获取通知

        :param db: 数据库会话
        :param pk: 通知 ID
        :return:
        """
        return await self.select_model(db, pk, deleted=0)

    async def get_select(self, user_id: int, title: str | None, category: int | None, *, unread: bool | None) -> Select:
        """
        获取「我的通知」列表查询表达式

        :param user_id: 当前用户 ID
        :param title: 标题（模糊匹配）
        :param category: 分类
        :param unread: True 只看未读、False 只看已读、None 不筛
        :return:
        """
        filters: list[ColumnElement[bool]] = [visible_to(user_id)]
        if unread is True:
            filters.append(_unread(user_id))
        elif unread is False:
            filters.append(~_unread(user_id))

        kwargs: dict[str, object] = {'deleted': 0}
        if title:
            kwargs['title__like'] = f'%{title}%'
        if category is not None:
            kwargs['category'] = category

        # 分页必须带 ORDER BY（SQL Server 的 OFFSET FETCH 强制要求）。
        # 排 `id` 而不是 `created_time`：雪花 ID 单调递增、且同一毫秒内也唯一，
        # 而 created_time 在批量插入时会撞成同一个值 —— 撞了之后翻页的行序
        # 在两次请求之间可以不一样，表现是「第 2 页有第 1 页看过的那条」。
        return await self.select_order('id', 'desc', *filters, **kwargs)

    async def get_read_map(self, db: AsyncSession, user_id: int, pks: Sequence[int]) -> dict[int, datetime]:
        """
        取这批通知里该用户已读的阅读时间

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :param pks: 通知 ID 列表
        :return:
        """
        if not pks:
            return {}
        stmt = select(NotificationRead.notification_id, NotificationRead.read_time).where(
            NotificationRead.user_id == user_id,
            NotificationRead.notification_id.in_(pks),
        )
        return {row[0]: row[1] for row in (await db.execute(stmt)).all()}

    async def count_unread_by_category(self, db: AsyncSession, user_id: int) -> dict[int, int]:
        """
        按分类统计未读数

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :return:
        """
        stmt = (
            select(Notification.category, func.count(Notification.id))
            .where(Notification.deleted == 0, visible_to(user_id), _unread(user_id))
            .group_by(Notification.category)
        )
        return {row[0]: row[1] for row in (await db.execute(stmt)).all()}

    async def create(self, db: AsyncSession, obj: CreateNotificationParam) -> Notification:
        """
        创建通知

        ⚠️ `flush=True` 不能省：`id` 是数据库侧生成的，不 flush 就返回，
        实例的 `id` 还是 `None`，序列化响应时直接 500（`plugin/notice` 踩过）。

        :param db: 数据库会话
        :param obj: 创建参数
        :return:
        """
        return await self.create_model(db, obj, flush=True)

    async def mark_read(self, db: AsyncSession, user_id: int, pks: Sequence[int]) -> int:
        """
        标记已读，幂等

        幂等靠「先查已读的、只插差集」而不是吃唯一约束冲突：SQL Server / PostgreSQL /
        MySQL 的冲突语法各不相同（`MERGE` / `ON CONFLICT` / `INSERT IGNORE`），
        写任一种都会在另外两种库上炸，而这个 fork 三种都要支持。

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :param pks: 通知 ID 列表
        :return: 本次真正新增的行数
        """
        if not pks:
            return 0
        already = set((await self.get_read_map(db, user_id, pks)).keys())
        fresh = [pk for pk in dict.fromkeys(pks) if pk not in already]
        if not fresh:
            return 0
        # 走 ORM 实例而不是 core `insert()`：`read_time` 的 `default_factory`
        # 和主键的雪花 `default` 都挂在映射上，core 批量插入拿不到前者。
        db.add_all([NotificationRead(notification_id=pk, user_id=user_id) for pk in fresh])
        await db.flush()
        return len(fresh)

    async def get_unread_ids(self, db: AsyncSession, user_id: int) -> list[int]:
        """
        取该用户全部未读通知的 ID

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :return:
        """
        stmt = select(Notification.id).where(Notification.deleted == 0, visible_to(user_id), _unread(user_id))
        return [row[0] for row in (await db.execute(stmt)).all()]

    async def delete_reads(self, db: AsyncSession, pks: Sequence[int]) -> int:
        """
        删除这批通知的所有已读标记（通知被删时一并清掉，避免留下悬空行）

        :param db: 数据库会话
        :param pks: 通知 ID 列表
        :return:
        """
        if not pks:
            return 0
        result = await db.execute(delete(NotificationRead).where(NotificationRead.notification_id.in_(pks)))
        return result.rowcount or 0


notification_dao: CRUDNotification = CRUDNotification(Notification)
