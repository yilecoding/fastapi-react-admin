from collections.abc import Sequence
from typing import Any

from sqlalchemy import ColumnElement, Row, Select, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.enums import StatusType
from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import NoticeWriteParam
from backend.plugin.notification.audience import Viewer, audience_admits, no_audience
from backend.plugin.notification.crud.crud_notification import unread_clause
from backend.plugin.notification.model import Notification
from backend.plugin.notification.sources import source_expr
from backend.utils.timezone import timezone

#: 入参里不是列的字段（附件另走 `sys_file_relation`，发布范围另走 `sys_notification_audience`）
_NON_COLUMN_FIELDS = {'attachment_ids', 'audience'}

#: 收件箱行 / 受众行的来源类型（`notice:<id>`）
NOTICE_SOURCE = 'notice'

#: 读者列表要的列。🔴 **不选正文**（#190）：正文是富文本、可以很长，列表一行都用不上它
FEED_COLUMNS = (
    Notice.id,
    Notice.title,
    Notice.type,
    Notice.pinned,
    Notice.level,
    Notice.expire_time,
    Notice.popup,
    Notice.require_ack,
    Notice.publish_time,
    Notice.created_time,
    Notice.updated_time,
)


def notice_source() -> ColumnElement[str]:
    """SQL 里这条公告的来源字符串（`'notice:' || id`），关联受众表 / 收件箱表用"""
    return source_expr(NOTICE_SOURCE, Notice.id)


def live_clause() -> ColumnElement[bool]:
    """「发出去了、还在」：没删 · 显示 · 已到发布时间 · 没过期。**不看受众**

    只有两处直接用它：登录页（不登录，没有「看的人」，所以那里另外要求没有受众限制）和定时任务（判该发 / 该撤）。
    给读者的一律用 `readable_clause(viewer)`
    """
    now = timezone.now()
    return and_(
        Notice.deleted == 0,
        Notice.status == StatusType.enable,
        or_(Notice.expire_time.is_(None), Notice.expire_time > now),
        or_(Notice.publish_time.is_(None), Notice.publish_time <= now),
    )


def readable_clause(viewer: Viewer) -> ColumnElement[bool]:
    """「这个人看得见这条公告」：`live_clause()` + 受众里有他（#186 / #190）

    🔴 **唯一一份**。给读者的列表、详情、弹窗、横幅、附件下载权限（`_notice_file_access`）、收件箱的附件数都用它 ——
    原来附件权限只看「没删」，于是隐藏的公告附件照样下得到（实测 200），而列表上已经看不见了。
    受众读的是和收件箱同一张表（`audience_admits`），所以「铃铛里有这条」和「点进去看得到」不会各说各的
    """
    return and_(live_clause(), audience_admits(viewer, notice_source()))


def _live_row() -> Select:
    """这条公告现在挂着的收件箱广播行（关联外层的 Notice）"""
    return select(Notification.id).where(
        Notification.source == notice_source(),
        Notification.recipient_id.is_(None),
        Notification.deleted == 0,
    )


def unread_by(viewer: Viewer) -> ColumnElement[bool]:
    """这个人还没读这条公告：有一行挂着的收件箱行，而那一行对他未读

    未读判定是通知插件那一份（含新账号规则：建号之前发的算已读）；🔴 例外是**必须确认的**（`require_ack`）
    只认显式的已读行 —— 必须点「我已阅读」的东西，新来的人也要点。
    没有收件箱行的（#186 之前发的、还没到发布时间的）不算未读：没有能标已读的东西，标成未读就永远是红点
    """
    return _live_row().where(unread_clause(viewer, explicit_only=Notice.require_ack)).exists()


def must_ack_inbox_rows() -> ColumnElement[bool]:
    """收件箱里属于「必须确认」、而且**还发着**（`live_clause`）的公告的那些行
    —— 登记给通知插件（`sources.register_explicit_ack`）

    🔴 这些行只能由读者在读者抽屉 / 弹窗 / 移动端详情里点「我已阅读」标已读（单条 `PUT /notifications/{id}/read`）：
    收件箱的「全部已读」跳过它们，列表那一行带 `requires_ack`、前端不摆「标为已读」，新账号规则也不作用于它们。
    判据和 `unread_by` 的 `explicit_only=Notice.require_ack` 是同一列 ——
    `unread_by` 只问看得见的公告，看得见就是还发着的。

    🔴 **只认还发着的**：过期了 / 被直接改成看不见、任务还没来得及撤回那一行时（最多 60 秒，任务也可能被停了），
    读者抽屉已经 404、弹窗不再弹，「我已阅读」无处可点；这时还要求「打开确认」，那一行就是谁也清不掉的红点。
    不再发着的必须确认公告，它的收件箱行就是普通的一行（「全部已读」、行上的「标记已读」都标得掉）。
    `live_clause()` 里有「现在」：通知插件每次查询才调这个工厂，所以每次都是新的
    """
    return Notification.source.in_(select(notice_source()).where(Notice.require_ack, live_clause()))


def _reader_time() -> ColumnElement[Any]:
    """读者看到的「发布时间」：定时发布的按发布时间，否则按创建时间。
    不按 `created_time` 排的话，一条一周前建好、今天才到点的公告会沉在一周前的位置"""
    return func.coalesce(Notice.publish_time, Notice.created_time)


class CRUDNotice(DataScopedCRUD[Notice]):
    #: 显式豁免数据权限 —— 公告是**全局内容**，而且这张表没有任何归属维度
    #:
    #: 🔴 **默默继承默认值（过滤）会让公告对所有受限用户消失。** 实测：
    #: 超管看到 3 条，STAFF 角色的用户看到 **0 条**（HTTP 200、空列表、无任何提示），
    #: 仪表盘那张统计卡也跟着显示 0。
    #:
    #: 原因是 fail-closed：`filter_data_permission_for_user` 里
    #: `if not data_rules: return or_(1 != 1)` —— 而四个种子演示角色都是
    #: 「开了 is_filter_scopes 但没配范围」。
    #:
    #: 而且这张表**没有可过滤的维度**：只有 `id / title / type / status / content`，
    #: 没有 `dept_id`、没有 `created_by`。规则想表达「某部门才看得到某公告」
    #: 压根表达不了 —— 所以过滤在这里只有 fail-closed 一种效果。
    #:
    #: ⚠️ `GET /sys/notices` 只挂 `DependsJwtAuth`、**没有权限门禁** ——
    #: 它是给所有登录用户看公告的接口（仪表盘也拿它做统计卡），
    #: 不是管理端列表。和菜单/字典同一类：滤掉了界面就空，而用户不知道为什么。
    data_scope_enabled = False

    """通知公告数据库操作类"""

    async def get(self, db: AsyncSession, pk: int) -> Notice | None:
        """
        获取通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """
        return await self.select_model(db, pk, deleted=0)

    async def get_select(self, title: str, type: int | None, status: int | None) -> Select:
        """
        获取通知公告列表查询表达式

        :param title: 通知公告标题
        :param type: 通知公告类型
        :param status: 通知公告状态
        :return:
        """
        filters = {'deleted': 0}

        if title is not None:
            filters['title__like'] = f'%{title}%'
        if type is not None:
            filters['type'] = type
        if status is not None:
            filters['status'] = status

        return await self.select_order('created_time', 'desc', **filters)

    async def get_readable(self, db: AsyncSession, viewer: Viewer, pk: int) -> Notice | None:
        """
        取一条这个人看得见的公告（隐藏 / 过期 / 没到发布时间 / 不在发布范围 / 删了的都当不存在）

        :param db: 数据库会话
        :param viewer: 看的人
        :param pk: 通知公告 ID
        :return:
        """
        return await db.scalar(select(Notice).where(Notice.id == pk, readable_clause(viewer)))

    def get_feed_select(self, viewer: Viewer) -> Select:
        """
        给读者的列表：置顶的在前，再按发布时间倒序。只选列表要的列（`FEED_COLUMNS`，不带正文）

        排序带上 `id`：同一毫秒建的两条（批量导入）时间相同，不带的话翻页顺序在两次请求间可以不一样

        :param viewer: 看的人
        :return:
        """
        return (
            select(*FEED_COLUMNS)
            .where(readable_clause(viewer))
            .order_by(Notice.pinned.desc(), _reader_time().desc(), Notice.id.desc())
        )

    async def get_unread_ids(self, db: AsyncSession, viewer: Viewer, pks: Sequence[int]) -> set[int]:
        """
        这批公告里这个人还没读的（判定见 `unread_by`）

        :param db: 数据库会话
        :param viewer: 看的人
        :param pks: 通知公告 ID 列表
        :return:
        """
        if not pks:
            return set()
        stmt = select(Notice.id).where(Notice.id.in_(list(pks)), unread_by(viewer))
        return set((await db.scalars(stmt)).all())

    async def get_popups(self, db: AsyncSession, viewer: Viewer, limit: int) -> Sequence[Notice]:
        """
        登录后要弹给这个人的：看得见 · 弹窗 · 没读。置顶 → 级别 → 新到旧

        :param db: 数据库会话
        :param viewer: 看的人
        :param limit: 最多几条
        :return:
        """
        # ⚠️ 布尔列直接当条件写（`Notice.popup`），不写 `.is_(True)`：后者在 SQL Server 上渲染成 `IS 1`，语法错
        stmt = (
            select(Notice)
            .where(readable_clause(viewer), Notice.popup, unread_by(viewer))
            .order_by(Notice.pinned.desc(), Notice.level.desc(), _reader_time().desc(), Notice.id.desc())
            .limit(limit)
        )
        return (await db.scalars(stmt)).all()

    async def get_banner(self, db: AsyncSession, viewer: Viewer, level: int, limit: int) -> Sequence[Row[Any]]:
        """
        横幅：看得见 · 置顶 · 指定级别 · 没读。只选列表要的列

        :param db: 数据库会话
        :param viewer: 看的人
        :param level: 级别
        :param limit: 最多几条
        :return:
        """
        stmt = (
            select(*FEED_COLUMNS)
            .where(readable_clause(viewer), Notice.pinned, Notice.level == level, unread_by(viewer))
            .order_by(_reader_time().desc(), Notice.id.desc())
            .limit(limit)
        )
        return (await db.execute(stmt)).all()

    async def get_public(self, db: AsyncSession, limit: int) -> Sequence[Row[Any]]:
        """
        登录页的公告（不登录也能看）：发出去了 · 登录页可见 · **没有发布范围**

        入参校验已经不许「登录页可见 + 有发布范围」同时存在；这里再要求一次没有受众行 ——
        直接改库、或者以后哪条写入路径漏了校验，也不会把限定范围的公告摆到登录页上

        :param db: 数据库会话
        :param limit: 最多几条
        :return:
        """
        stmt = (
            select(
                Notice.id,
                Notice.title,
                Notice.level,
                Notice.pinned,
                Notice.publish_time,
                Notice.created_time,
                Notice.content,
            )
            .where(live_clause(), Notice.public, no_audience(notice_source()))
            .order_by(Notice.pinned.desc(), _reader_time().desc(), Notice.id.desc())
            .limit(limit)
        )
        return (await db.execute(stmt)).all()

    async def get_due_ids(self, db: AsyncSession) -> list[int]:
        """
        到了发布时间、还没发出去的（定时任务 `notice.sync_inbox` 用）：发出去了 · 定过发布时间 · 没有挂着的收件箱行

        🔴 只认**定过**发布时间的。没定的（立即发布）建的时候就发了；没有收件箱行的老公告（#186 之前的、认领不上的）
        要是也算进来，第一次跑就把它们全员重发一遍

        :param db: 数据库会话
        :return:
        """
        stmt = (
            select(Notice.id)
            .where(live_clause(), Notice.publish_time.is_not(None), ~_live_row().exists())
            .order_by(Notice.id)
        )
        return list((await db.scalars(stmt)).all())

    async def get_stale_ids(self, db: AsyncSession) -> list[int]:
        """
        收件箱行还挂着、公告本身已经不该被看见的（过期为主；隐藏 / 删除 / 改成未来发布在写入时就撤了，这里兜底）

        :param db: 数据库会话
        :return:
        """
        stmt = select(Notice.id).where(~live_clause(), _live_row().exists()).order_by(Notice.id)
        return list((await db.scalars(stmt)).all())

    async def lock(self, db: AsyncSession, pk: int) -> Notice | None:
        """
        锁住一条公告（到事务结束）再读：定时任务（`publish_scheduled` / `retract_stale`）和管理员编辑（`update`）
        都先拿它，同一条公告的收件箱对齐一次只有一个在做 —— 不会一边判「该发」一边被改成隐藏，
        也不会两边都判「没有行」各发一行。
        删除不用它：`delete` 先 UPDATE 了公告行（一样是行锁），之后才去撤收件箱行

        SQL Server 不认 `FOR UPDATE`（SQLAlchemy 在 mssql 上什么都不渲染），要写表提示

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """
        stmt = (
            select(Notice)
            .where(Notice.id == pk)
            .with_for_update()
            .with_hint(Notice.__table__, 'WITH (UPDLOCK, ROWLOCK)', 'mssql')
            .execution_options(populate_existing=True)
        )
        return await db.scalar(stmt)

    async def get_all(self, db: AsyncSession) -> Sequence[Notice]:
        """
        获取所有通知公告

        :param db: 数据库会话
        :return:
        """
        return await self.select_models(db, deleted=0)

    async def create(self, db: AsyncSession, obj: NoticeWriteParam) -> Notice:
        """
        创建通知公告，返回创建出来的对象

        返回**实例**而不是 None：正文里的内联图要在保存后挂到
        `sys_file_relation` 上（`target_id` 就是这条公告的 id），
        而创建接口原来不下发 id —— 前端拿不到 id 就没法挂关联，
        于是新建公告里的图会变成谁也不认领的孤儿文件。

        ⚠️ flush 不能省。`id` 是数据库侧生成的（`id_key` → BigInteger 主键）——
        不 flush 就返回，实例的 `id` 还是 `None`，序列化响应时直接 500：
        `1 validation error: ('response','data','id') Input should be a valid integer`
        （实测踩到）。事务仍由 `CurrentSessionTransaction` 统一提交。

        不走 `create_model`：它把整个入参 `model_dump()` 塞进模型，`attachment_ids` 不是列，当场 TypeError。

        :param db: 数据库会话
        :param obj: 创建通知公告参数
        :return:
        """
        notice = self.model(**obj.model_dump(exclude=_NON_COLUMN_FIELDS))
        db.add(notice)
        await db.flush()
        return notice

    async def update(self, db: AsyncSession, pk: int, obj: NoticeWriteParam) -> int:
        """
        更新通知公告

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :param obj: 更新通知公告参数
        :return:
        """
        # `exclude_unset`：没传的字段不写。置顶 / 级别 / 过期时间在入参上有默认值，整份写回的话
        # 只传了标题和正文的调用方（脚本、老客户端）会把一条置顶 + 紧急 + 有期限的公告悄悄改回默认值
        data = obj.model_dump(exclude=_NON_COLUMN_FIELDS, exclude_unset=True)
        return await self.update_model_by_column(db, data, id=pk, deleted=0)

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """
        批量删除通知公告

        :param db: 数据库会话
        :param pks: 通知公告 ID 列表
        :return:
        """
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


notice_dao: CRUDNotice = CRUDNotice(Notice)
