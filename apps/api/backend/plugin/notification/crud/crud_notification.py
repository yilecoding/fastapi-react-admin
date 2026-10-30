from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import ColumnElement, Select, and_, case, delete, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notification.audience import Viewer, audience_admits
from backend.plugin.notification.model import Notification, NotificationRead
from backend.plugin.notification.schema.notification import CreateNotificationParam
from backend.plugin.notification.sources import explicit_ack_clause
from backend.utils.timezone import timezone


def visible_to(viewer: Viewer) -> ColumnElement[bool]:
    """「这个人能看见哪些通知」——点名给他的，或者广播（`recipient_id IS NULL`）里受众包含他的

    单独抽出来是因为它出现在四个地方（列表 / 未读数 / 标已读 / 全部已读），
    抄第二遍就会有人漏掉 `IS NULL` 那一半，而漏掉的表现是**公告一条都看不见**，
    不报错。

    广播的受众（#190）在 `sys_notification_audience` 里，按 `source` 关联：没有来源的（每日问候、手动全员发）
    和来源没有受众行的都是全员。公告本身的可见性读的是同一张表（`audience_admits`），两边不会各说各的
    """
    return or_(
        Notification.recipient_id == viewer.id,
        and_(
            Notification.recipient_id.is_(None),
            or_(Notification.source.is_(None), audience_admits(viewer, Notification.source)),
        ),
    )


def _read_by(user_id: int) -> ColumnElement[bool]:
    """`sys_notification_read` 里有这个人对这一行的已读标记（显式读过）"""
    return (
        select(NotificationRead.id)
        .where(
            NotificationRead.notification_id == Notification.id,
            NotificationRead.user_id == user_id,
        )
        .exists()
    )


def implicitly_read(viewer: Viewer) -> ColumnElement[bool]:
    """新账号规则（#190）：**建号之前**写的广播行对他算已读 —— 不计红点、列表里的阅读时间回填成建号时间

    不这样的话，新来的人一登录就是几十条历史公告的红点，而那些早就不是「新消息」了。
    点名给他的行不可能早于建号，不受影响
    """
    return and_(Notification.recipient_id.is_(None), Notification.created_time < viewer.join_time)


def unread_clause(viewer: Viewer, *, explicit_only: ColumnElement[bool]) -> ColumnElement[bool]:
    """给来源方用的未读判定：`explicit_only` 为真的行只认显式已读（不吃新账号规则）

    公告的「必须确认」（`require_ack`）走这条：必须点「我已阅读」的东西，新来的人也要点
    """
    return and_(~_read_by(viewer.id), or_(explicit_only, ~implicitly_read(viewer)))


def _unread(viewer: Viewer) -> ColumnElement[bool]:
    """收件箱的未读 = 没有显式的已读标记，也不是建号之前的广播 —— **必须读者打开确认的行除外**（只认显式已读）

    🔴 例外和公告那一侧（`crud_notice.unread_by` 的 `explicit_only`）必须是同一个口径。原来这里对所有行都吃新账号规则：
    建号晚于一条必须确认的公告的人，铃铛里那一行是已读（不计红点、`read_time` 回填、`requires_ack_count` 不算它），
    弹窗却要他点「我已阅读」。「必须确认」由来源方登记（`sources.explicit_ack_clause`），这里和「全部已读」读的是同一份
    """
    needs_ack = explicit_ack_clause()
    if needs_ack is None:
        return and_(~_read_by(viewer.id), ~implicitly_read(viewer))
    return unread_clause(viewer, explicit_only=needs_ack)


def implicit_read_time(
    viewer: Viewer, *, recipient_id: int | None, created_time: datetime, requires_ack: bool
) -> datetime | None:
    """列表里那一行按新账号规则算已读时，阅读时间回填成建号时间（同 `_unread`，给已经查出来的行用）。
    必须读者打开确认的行不回填（同 `_unread` 的例外）"""
    if not requires_ack and recipient_id is None and created_time < viewer.join_time:
        return viewer.join_time
    return None


class CRUDNotification(DataScopedCRUD[Notification]):
    """站内通知数据库操作类"""

    # 收件箱是**按人**过滤的，不是按部门/角色的数据范围过滤。这里每一条查询都
    # 强制带上 `visible_to(viewer)`，再叠一层 fail-open 的数据权限只会
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

    async def get_visible(self, db: AsyncSession, viewer: Viewer, pk: int) -> Notification | None:
        """
        取一条这个人看得见的通知（看不见的当不存在）

        :param db: 数据库会话
        :param viewer: 看的人
        :param pk: 通知 ID
        :return:
        """
        return await db.scalar(
            select(Notification).where(Notification.id == pk, Notification.deleted == 0, visible_to(viewer))
        )

    async def get_select(
        self, viewer: Viewer, title: str | None, category: int | None, *, unread: bool | None
    ) -> Select:
        """
        获取「我的通知」列表查询表达式

        :param viewer: 看的人
        :param title: 标题（模糊匹配）
        :param category: 分类
        :param unread: True 只看未读、False 只看已读、None 不筛
        :return:
        """
        filters: list[ColumnElement[bool]] = [visible_to(viewer)]
        if unread is True:
            filters.append(_unread(viewer))
        elif unread is False:
            filters.append(~_unread(viewer))

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

    async def count_unread(self, db: AsyncSession, viewer: Viewer) -> tuple[dict[int, int], int]:
        """
        未读数：按分类的条数 + 其中几条必须读者打开确认（「全部已读」标不掉的那几条）。**一条查询**

        两个数同一个未读口径，所以「未读总数 − 要确认的」恰好是「全部已读」会标掉的条数。
        铃铛每次收件箱变动都重拉这个数，原来是两条查询把同一批未读各扫一遍（#190 评审）。

        ⚠️ 「要不要确认」先在内层算成一列 0 / 1，外层再 SUM：SQL Server 不许聚合函数里套子查询
        （`SUM(CASE WHEN source IN (SELECT …) …)` 报 130），而登记的条件里就是子查询

        :param db: 数据库会话
        :param viewer: 看的人
        :return: ({分类: 未读条数}, 要确认的未读条数)
        """
        needs_ack = explicit_ack_clause()
        flag = case((needs_ack, 1), else_=0) if needs_ack is not None else literal_column('0')
        rows = (
            select(Notification.category.label('category'), flag.label('needs_ack'))
            .where(Notification.deleted == 0, visible_to(viewer), _unread(viewer))
            .subquery()
        )
        stmt = select(rows.c.category, func.count(), func.sum(rows.c.needs_ack)).group_by(rows.c.category)
        by_category: dict[int, int] = {}
        requires_ack = 0
        for category, count, acks in (await db.execute(stmt)).all():
            by_category[category] = int(count)
            # MySQL 的 SUM 回来是 Decimal
            requires_ack += int(acks or 0)
        return by_category, requires_ack

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

    async def get_explicit_ack_ids(self, db: AsyncSession, pks: Sequence[int]) -> set[int]:
        """
        这批通知里哪些必须读者打开确认（列表那一行的 `requires_ack`）

        :param db: 数据库会话
        :param pks: 通知 ID 列表
        :return:
        """
        needs_ack = explicit_ack_clause()
        if not pks or needs_ack is None:
            return set()
        stmt = select(Notification.id).where(Notification.id.in_(list(pks)), needs_ack)
        return set((await db.scalars(stmt)).all())

    async def get_unread_ids(self, db: AsyncSession, viewer: Viewer) -> list[int]:
        """
        取这个人全部未读、**可以批量标已读**的通知 ID（「全部已读」用）

        🔴 必须读者打开确认的（公告的「必须确认」，来源方 `sources.register_explicit_ack` 登记）不在里面：
        原来这里只有未读条件，点一下「全部已读」就替人把「我已阅读」点掉了 —— 弹窗不再弹、阅读统计里成了已读

        :param db: 数据库会话
        :param viewer: 看的人
        :return:
        """
        filters: list[ColumnElement[bool]] = [Notification.deleted == 0, visible_to(viewer), _unread(viewer)]
        needs_ack = explicit_ack_clause()
        if needs_ack is not None:
            filters.append(~needs_ack)
        stmt = select(Notification.id).where(*filters)
        return [row[0] for row in (await db.execute(stmt)).all()]

    async def get_ids_by_sources(self, db: AsyncSession, sources: Sequence[str]) -> dict[str, int]:
        """
        来源 → 收件箱里那一行的 ID（只认广播行；同一来源有多行时取最新的）

        :param db: 数据库会话
        :param sources: 来源列表（`notice:123`）
        :return:
        """
        if not sources:
            return {}
        stmt = (
            select(Notification.source, Notification.id)
            .where(
                Notification.source.in_(list(dict.fromkeys(sources))),
                Notification.recipient_id.is_(None),
                Notification.deleted == 0,
            )
            .order_by(Notification.id)
        )
        # 按 id 升序灌进 dict，后来的覆盖先来的 = 取最新那一行
        return {row[0]: row[1] for row in (await db.execute(stmt)).all()}

    async def get_live_by_source(self, db: AsyncSession, source: str) -> Notification | None:
        """
        一个来源现在挂着的那一行广播（同一来源有多行时取最新的；撤回了的不算）

        :param db: 数据库会话
        :param source: 来源
        :return:
        """
        stmt = (
            select(Notification)
            .where(Notification.source == source, Notification.recipient_id.is_(None), Notification.deleted == 0)
            .order_by(Notification.id.desc())
            .limit(1)
        )
        return await db.scalar(stmt)

    async def update_by_source(self, db: AsyncSession, source: str, *, title: str, content: str) -> int:
        """
        改一个来源对应的收件箱行的标题 / 摘要（公告改了标题，铃铛里那一行跟着改）

        :param db: 数据库会话
        :param source: 来源
        :param title: 标题
        :param content: 摘要
        :return:
        """
        return await self.update_model_by_column(
            db, {'title': title[:128], 'content': content}, allow_multiple=True, source=source, deleted=0
        )

    async def retract_by_source(self, db: AsyncSession, source: str) -> int:
        """
        撤回一个来源发出来的收件箱行（逻辑删除 + 清掉已读标记）。公告隐藏 / 删除时调

        :param db: 数据库会话
        :param source: 来源
        :return: 撤回的行数
        """
        pks = list(
            (
                await db.scalars(
                    select(Notification.id).where(Notification.source == source, Notification.deleted == 0)
                )
            ).all()
        )
        if not pks:
            return 0
        await self.delete_reads(db, pks)
        return await self.delete_model_by_column(
            db,
            allow_multiple=True,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id__in=pks,
            deleted=0,
        )

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
