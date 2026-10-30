from collections.abc import Iterable, Sequence
from datetime import datetime
from html.parser import HTMLParser
from typing import Any

from sqlalchemy import Row, and_, false, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_dao, file_relation_dao
from backend.app.admin.model import Dept, File, FileRelation, Role, User
from backend.app.admin.service.file_service import file_service, register_file_access, register_relation_guard
from backend.common.enums import StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import count_rows, paging_data
from backend.common.response.response_code import StandardResponseCode
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.rbac import user_has_perm
from backend.core.conf import settings
from backend.plugin.notice.crud.crud_notice import (
    FEED_COLUMNS,
    NOTICE_SOURCE,
    must_ack_inbox_rows,
    notice_dao,
    readable_clause,
)
from backend.plugin.notice.enums import NoticeLevel
from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import CreateNoticeParam, DeleteNoticeParam, UpdateNoticeParam
from backend.plugin.notification.audience import Viewer, audience_user_clause, normalize_audience
from backend.plugin.notification.crud.crud_audience import notification_audience_dao
from backend.plugin.notification.crud.crud_notification import notification_dao
from backend.plugin.notification.enums import AudienceKind
from backend.plugin.notification.model import NotificationRead
from backend.plugin.notification.service.notification_service import (
    notification_service,
    push_broadcast_after_commit,
)
from backend.plugin.notification.sources import make_source, register_explicit_ack, register_source_attachments
from backend.utils.timezone import timezone

#: 一条公告挂着两种独立的附件关系（前端 `pages/notice/api.ts` 的常量）：
#: `NOTICE` 是"附件"面板，`NOTICE_CONTENT` 是正文里的内联图。两者都要在
#: 公告删除时一并解除关联，否则 (issue #63) 已删除公告的图片仍能通过
#: `GET /sys/files/targets/{target_type}/{target_id}` 被任意登录用户查到。
NOTICE_ATTACHMENT_TARGET = 'NOTICE'
_NOTICE_TARGET_TYPES = (NOTICE_ATTACHMENT_TARGET, 'NOTICE_CONTENT')

#: 登录后弹窗最多弹几条（#190）。积压太多一条条点「知道了」没人受得了，剩下的在工作台
POPUP_LIMIT = 10
#: 横幅最多几条
BANNER_LIMIT = 3
#: 登录页最多几条
PUBLIC_LIMIT = 5
#: 登录页摘要的长度（字符）
PUBLIC_SUMMARY_LENGTH = 200


def notice_link(pk: int) -> str:
    """收件箱 / 群机器人里那条公告指向哪：消息中心就地打开这一条（任何登录用户都进得去）

    🔴 原来是 `/plugins/notice` —— 管理页，路由守卫要 `sys:notice:add`，普通用户点进去是 403，
    而且点这一下已经把它标成已读了（#186 实测）。群机器人卡片里的链接也是它
    """
    return f'/notification?notice={pk}'


def _aware(value: datetime | None) -> datetime | None:
    """入参里的时间可能不带时区（`2026-11-01 18:00:00`），和带时区的 now 比会 TypeError；
    按应用时区补上标记，同 `TimeZone.process_bind_param` 对 naive 值的处理"""
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.tz_info)
    return value


def _is_live(status: int, expire_time: datetime | None, publish_time: datetime | None) -> bool:
    """显示中、到了发布时间、没过期 —— 同 `crud_notice.live_clause()`，给还没落库 / 刚改完的值判一次"""
    now = timezone.now()
    expire_time, publish_time = _aware(expire_time), _aware(publish_time)
    return (
        status == StatusType.enable
        and (expire_time is None or expire_time > now)
        and (publish_time is None or publish_time <= now)
    )


def _can_manage(user: Any) -> bool:
    """管理端的人（能进管理页的）隐藏 / 过期的也看得到 —— 编辑时要预览附件"""
    return user_has_perm(user, 'sys:notice:add') or user_has_perm(user, 'sys:notice:edit')


async def _notice_file_access(db: AsyncSession, user: Any, file: Any) -> bool:
    """挂在公告上的附件 / 正文图：**看得见这条公告，才打得开它的附件**（#186）

    🔴 原来只看「公告没删」，于是隐藏的公告附件照样下得到（实测 200），而列表上已经看不见了。
    现在和读者列表用同一个 `readable_clause(viewer)`（#190 起含发布范围：不在范围里的人拿到文件 ID 也下不了）；
    管理端的人对没删的都放行（编辑表单里要预览）
    """
    from backend.plugin.notification.audience import viewer_of

    stmt = (
        select(func.count())
        .select_from(FileRelation)
        .join(Notice, Notice.id == FileRelation.target_id)
        .where(
            FileRelation.file_id == file.id,
            FileRelation.deleted == 0,
            FileRelation.target_type.in_(_NOTICE_TARGET_TYPES),
        )
    )
    if _can_manage(user):
        stmt = stmt.where(Notice.deleted == 0)
    else:
        stmt = stmt.where(readable_clause(await viewer_of(db, user)))
    return bool(await db.scalar(stmt))


register_file_access(_notice_file_access)


def _can_attach(user: Any) -> bool:
    """往公告上挂 / 卸附件：要公告自己的权限（`file_service.register_relation_guard`）

    ⚠️ casbin 模式（`RBAC_ROLE_MENU_MODE=False`）下权限码模型不适用，`user_has_perm` 对非超管一律 False ——
    在那里收紧等于公告管理员连正文里的图都挂不上（前端吞掉了那个错误，图就成了孤儿）。那种模式下退回原来的
    `sys:file:upload` 一道闸，路由层的 casbin 照常按路径鉴权
    """
    return not settings.RBAC_ROLE_MENU_MODE or _can_manage(user)


for _target_type in _NOTICE_TARGET_TYPES:
    register_relation_guard(_target_type, _can_attach)


async def _count_attachments(db: AsyncSession, pks: Sequence[int]) -> dict[int, int]:
    """一批公告各有几个附件（只数没进回收站的文件）。收件箱列表的回形针也用它"""
    if not pks:
        return {}
    stmt = (
        select(FileRelation.target_id, func.count())
        .join(File, File.id == FileRelation.file_id)
        .where(
            FileRelation.target_type == NOTICE_ATTACHMENT_TARGET,
            FileRelation.target_id.in_(list(pks)),
            FileRelation.deleted == 0,
            File.deleted == 0,
        )
        .group_by(FileRelation.target_id)
    )
    return {row[0]: row[1] for row in (await db.execute(stmt)).all()}


async def _count_readable_attachments(db: AsyncSession, pks: Sequence[int], viewer: Viewer) -> dict[int, int]:
    """收件箱那边按来源要附件数：这个人看不见的公告不报数（同 `readable_clause(viewer)`）"""
    readable = list(
        (await db.scalars(select(Notice.id).where(Notice.id.in_(list(pks)), readable_clause(viewer)))).all()
    )
    return await _count_attachments(db, readable)


register_source_attachments(NOTICE_SOURCE, _count_readable_attachments)
# 必须确认的公告：收件箱的「全部已读」跳过它，列表那一行不给「标为已读」（只能在读者抽屉 / 弹窗里点「我已阅读」）
register_explicit_ack(NOTICE_SOURCE, must_ack_inbox_rows)


def _summary(title: str) -> str:
    """收件箱里那一行的摘要。

    ⚠️ **正文不复制进通知里**。公告正文是富文本（含内联图，图的可见性挂在
    `sys_file_relation` 上），复制一份进 `sys_notification` 就有了两份会各自
    过期的真相；公告改了内容、收件箱里那份还是旧的，而且不会有人发现。
    这里只放一句摘要，点进去看的永远是公告本身。

    ⚠️ 摘要**永远是中文**，不过 `t()`。它在发布那一刻就写进库了，而读它的人
    可能是任何语言 —— 翻译只能按「发布者当时的 Accept-Language」定，那是错的
    锚点。同 `app/task/tasks/base.py: TaskBase` 里那三条推送文案的取舍。
    """
    return f'公告《{title}》已发布，点击查看详情。'


#: 这些标签前后断开（不然 `<p>甲</p><p>乙</p>` 摘要里成了「甲乙」）
_BLOCK_TAGS = frozenset(
    {'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'blockquote', 'pre', 'hr', 'section', 'article'}
    | {f'h{i}' for i in range(1, 7)}
)


class _TextOnly(HTMLParser):
    """只留文字：标签去掉、实体解码、`<script>` / `<style>` 里的内容整段丢掉、图片什么都不留"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {'script', 'style'}:
            self._skip += 1
        elif tag in _BLOCK_TAGS:
            self.parts.append(' ')

    def handle_endtag(self, tag: str) -> None:
        if tag in {'script', 'style'}:
            self._skip = max(0, self._skip - 1)
        elif tag in _BLOCK_TAGS:
            self.parts.append(' ')

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def plain_summary(content: str, limit: int = PUBLIC_SUMMARY_LENGTH) -> str:
    """富文本正文 → 纯文本摘要（登录页用，#190）。超出 `limit` 截断、末尾一个省略号，总长不超过 `limit`

    🔴 登录页不登录也能看，所以**只给纯文本**：正文里的图、链接、附件一样都不出去（内联图是公开文件，
    但摆到登录页上就成了谁都能看的东西）
    """
    parser = _TextOnly()
    parser.feed(content or '')
    parser.close()
    text = ' '.join(''.join(parser.parts).split())
    if len(text) <= limit:
        return text
    return text[: limit - 1] + '…'


async def _broadcast(db: AsyncSession, pk: int, title: str, *, restricted: bool) -> None:
    """公告发布时顺带往站内收件箱写一条广播，带上来源，好反查 / 撤回。谁看得见由受众表决定（`visible_to`）

    🔴 有发布范围的不推群机器人：机器人发进的是一整个群，管不了「只给技术中心看」
    """
    await notification_service.broadcast(
        db=db,
        title=title,
        content=_summary(title),
        link=notice_link(pk),
        kind='announcement',
        source=make_source(NOTICE_SOURCE, pk),
        to_bots=not restricted,
    )


async def _retract(db: AsyncSession, pk: int) -> int:
    """公告隐藏 / 删除 / 过期：收件箱那一行一起撤回，不然标题还挂在所有人的铃铛里、点进去是「不存在」

    撤回了就要推一次：不推的话在线的人红点里还数着这一行，点进去是「已撤回」，要等下一次重拉才对
    """
    count = await notification_dao.retract_by_source(db, make_source(NOTICE_SOURCE, pk))
    if count:
        push_broadcast_after_commit(db)
    return count


async def _sync_attachments(db: AsyncSession, *, user: Any, pk: int, file_ids: list[int]) -> None:
    """把公告的附件对齐成 `file_ids`（按给的顺序，新挂的接在后面）。在调用方的事务里，发广播之前

    三道校验，任何一道不过整条回滚（公告和广播都不落）：

    - 文件要存在、没进回收站
    - 🔴 **操作人自己读得了这个文件**。不校验的话，有发公告权限的人能把任何人的私有文件
      （拿得到 ID 就行，雪花 ID 不是秘密）挂上来，等于借公告把它公开给所有人
    - 🔴 **不能是公开文件**。公开文件不登录也能下（`/uploads/{key}`），挂上去以后
      「看得见公告才打得开附件」这条规则对它不成立 —— 隐藏 / 过期了照样下得到
    """
    wanted = list(dict.fromkeys(file_ids))
    if wanted:
        with bypass_data_scope():
            files = await file_dao.get_by_ids(db, wanted)
        by_id = {f.id: f for f in files}
        for fid in wanted:
            file = by_id.get(fid)
            if file is None or not await file_service.can_read(db=db, user=user, file=file):
                raise errors.RequestError(msg=t('error.notice.attachment_invalid'))
            if file.is_public:
                raise errors.RequestError(msg=t('error.notice.attachment_public', name=file.original_name))

    # 进回收站的文件不会出现在这里：删文件时它的关联已经一起解开了（同一个删除时间），还原时再挂回来
    current = list(await file_relation_dao.get_file_ids_by_target(db, NOTICE_ATTACHMENT_TARGET, pk))
    removed = [fid for fid in current if fid not in wanted]
    added = [fid for fid in wanted if fid not in current]
    if removed:
        await file_relation_dao.delete_by_target(db, NOTICE_ATTACHMENT_TARGET, pk, removed)
    if added:
        base_sort = await file_relation_dao.get_max_sort(db, NOTICE_ATTACHMENT_TARGET, pk)
        await file_relation_dao.bulk_create(
            db,
            [
                {
                    'file_id': fid,
                    'target_type': NOTICE_ATTACHMENT_TARGET,
                    'target_id': pk,
                    'sort': base_sort + offset,
                    'created_by': user.id,
                }
                for offset, fid in enumerate(added, start=1)
            ],
        )


def _check_combination(*, popup: bool, require_ack: bool, public: bool, has_audience: bool) -> None:
    """几个开关之间的约束（#190），按**生效后**的值判（PUT 没传的字段按库里原值）。不合法 422

    - 必须确认只在弹窗时有意义：不弹窗的话「必须点我已阅读」没有出口
    - 登录页可见 = 不登录的人都看得到，和「只给技术中心看」自相矛盾
    """
    if require_ack and not popup:
        raise errors.RequestError(code=StandardResponseCode.HTTP_422, msg=t('error.notice.require_ack_needs_popup'))
    if public and has_audience:
        raise errors.RequestError(code=StandardResponseCode.HTTP_422, msg=t('error.notice.public_with_audience'))


#: 受众类型 → (模型, 显示名那一列)
def _audience_targets() -> dict[str, tuple[Any, Any]]:
    return {
        AudienceKind.dept.value: (Dept, Dept.name),
        AudienceKind.role.value: (Role, Role.name),
        AudienceKind.user.value: (User, User.nickname),
    }


async def _check_audience_targets(db: AsyncSession, entries: Sequence[tuple[str, int]]) -> None:
    """发布范围里点的部门 / 角色 / 用户都要存在（没删）

    不存在的 ID 进了受众表谁也匹配不上 —— 这条公告就对所有人静默消失了
    """
    by_kind: dict[str, set[int]] = {}
    for kind, target_id in entries:
        by_kind.setdefault(kind, set()).add(target_id)
    for kind, (model, _name) in _audience_targets().items():
        ids = by_kind.get(kind)
        if not ids:
            continue
        found = set((await db.scalars(select(model.id).where(model.id.in_(sorted(ids)), model.deleted == 0))).all())
        if found != ids:
            raise errors.RequestError(msg=t('error.notice.audience_invalid'))


async def _audience_items(db: AsyncSession, sources: Iterable[str]) -> dict[str, list[dict[str, Any]]]:
    """一批来源的发布范围，带显示名（部门 / 角色名称、用户昵称；对象已删除时为空）"""
    by_source = await notification_audience_dao.get_by_sources(db, list(sources))
    wanted: dict[str, set[int]] = {}
    for entries in by_source.values():
        for kind, target_id in entries:
            wanted.setdefault(kind, set()).add(target_id)
    names: dict[tuple[str, int], str] = {}
    for kind, (model, name_col) in _audience_targets().items():
        ids = wanted.get(kind)
        if ids:
            stmt = select(model.id, name_col).where(model.id.in_(sorted(ids)), model.deleted == 0)
            for pk, name in (await db.execute(stmt)).all():
                names[kind, pk] = name
    return {
        source: [{'kind': kind, 'target_id': tid, 'name': names.get((kind, tid))} for kind, tid in entries]
        for source, entries in by_source.items()
    }


async def _decorate_for_admin(db: AsyncSession, items: list[dict[str, Any]]) -> None:
    """管理端那一份补上附件数 · 发布范围（原地改 dict）"""
    pks = [item['id'] for item in items]
    counts = await _count_attachments(db, pks)
    audience = await _audience_items(db, [make_source(NOTICE_SOURCE, pk) for pk in pks])
    for item in items:
        item['attachment_count'] = counts.get(item['id'], 0)
        item['audience'] = audience.get(make_source(NOTICE_SOURCE, item['id']), [])


async def _decorate_for_reader(db: AsyncSession, viewer: Viewer, items: list[dict[str, Any]]) -> None:
    """给读者那一份补上附件数 · 收件箱行 · 读没读（原地改 dict）

    「读没读」和弹窗 / 横幅用同一个判定（`crud_notice.unread_by`）：没有收件箱行的算已读、建号之前发的算已读、
    必须确认的只认显式已读
    """
    pks = [item['id'] for item in items]
    counts = await _count_attachments(db, pks)
    rows = await notification_dao.get_ids_by_sources(db, [make_source(NOTICE_SOURCE, pk) for pk in pks])
    unread = await notice_dao.get_unread_ids(db, viewer, pks)
    for item in items:
        item['attachment_count'] = counts.get(item['id'], 0)
        item['notification_id'] = rows.get(make_source(NOTICE_SOURCE, item['id']))
        item['read'] = item['id'] not in unread


def _rows_to_dicts(rows: Sequence[Row[Any]]) -> list[dict[str, Any]]:
    """分页查的是几列（不是整个模型）时，`paging_data` 拿到的是 Row，转成 dict 好往里补字段"""
    return [dict(row._mapping) for row in rows]


def _columns(notice: Notice) -> dict[str, Any]:
    return {column.key: getattr(notice, column.key) for column in Notice.__table__.columns}


def _feed_item(notice: Notice, *, content: bool) -> dict[str, Any]:
    item = {column.key: getattr(notice, column.key) for column in FEED_COLUMNS}
    if content:
        item['content'] = notice.content
    return item


async def _align_inbox(
    db: AsyncSession,
    pk: int,
    *,
    title: str,
    old_title: str,
    shown: bool,
    live_row: int | None,
    restricted: bool,
    audience_changed: bool,
    widened: bool,
) -> None:
    """改完一条公告，收件箱那一行按「现在该不该被看见」对齐。判据是**有没有挂着的那一行**，不是改之前的字段：

    - 该看见、没有行 → 发（隐藏改显示、过期时间往后挪、发布时间改到了现在之前）
    - 不该看见、有行 → 撤（隐藏、改成已过期、已发布的改成未来时间）
    - 一直看得见 → 不重发（否则改个错别字就给全员再发一遍红点）；改了标题就改那一行的标题、
      改了发布范围就推一次让在线的人重拉（受众表是现查的，多出来 / 少掉的那条当场对上）
    - 🔴 一直看得见、发布范围从「指定」放宽成全员（`widened`）→ 补推群机器人：发的时候有范围、
      没推群（`to_bots=False`），不补的话这条公告永远进不了群。挂在**那一行**上补（站内不重写），那一行推过群就不再推

    :param live_row: 改之前挂着的那一行收件箱行的 ID（没有就是 None）
    """
    if shown and live_row is None:
        await _broadcast(db, pk, title, restricted=restricted)
    elif not shown and live_row is not None:
        await _retract(db, pk)
    elif shown and live_row is not None:
        source = make_source(NOTICE_SOURCE, pk)
        renamed = title != old_title and await notification_dao.update_by_source(
            db, source, title=title, content=_summary(title)
        )
        if widened:
            await notification_service.broadcast_to_bots(
                db=db, notification_id=live_row, title=title, content=_summary(title), link=notice_link(pk)
            )
        if renamed or audience_changed:
            push_broadcast_after_commit(db)


class NoticeService:
    """通知公告服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> dict[str, Any]:
        """
        获取通知公告（管理端）

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """

        notice = await notice_dao.get(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        item = _columns(notice)
        await _decorate_for_admin(db, [item])
        return item

    @staticmethod
    async def get_list(db: AsyncSession, title: str | None, type: int | None, status: int | None) -> dict[str, Any]:
        """
        获取通知公告列表（管理端）

        :param db: 数据库会话
        :param title: 通知公告标题
        :param type: 通知公告类型
        :param status: 通知公告状态
        :return:
        """
        notice_select = await notice_dao.get_select(title, type, status)
        page_data = await paging_data(db, notice_select)
        await _decorate_for_admin(db, list(page_data['items']))
        return page_data

    @staticmethod
    async def get_feed(*, db: AsyncSession, viewer: Viewer) -> dict[str, Any]:
        """
        给所有登录用户看的公告列表（工作台 / 移动端首页）：这个人看得见的，置顶在前。不带正文

        :param db: 数据库会话
        :param viewer: 看的人
        :return:
        """
        page_data = await paging_data(db, notice_dao.get_feed_select(viewer), transformer=_rows_to_dicts)
        await _decorate_for_reader(db, viewer, list(page_data['items']))
        return page_data

    @staticmethod
    async def get_feed_detail(*, db: AsyncSession, viewer: Viewer, pk: int) -> dict[str, Any]:
        """
        给所有登录用户看的公告详情。隐藏 / 过期 / 没到发布时间 / 不在发布范围 / 删了的一律 404
        （不区分，不泄露「这条存在」）

        :param db: 数据库会话
        :param viewer: 看的人
        :param pk: 通知公告 ID
        :return:
        """
        notice = await notice_dao.get_readable(db, viewer, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        item = _feed_item(notice, content=True)
        await _decorate_for_reader(db, viewer, [item])
        return item

    @staticmethod
    async def get_popups(*, db: AsyncSession, viewer: Viewer) -> list[dict[str, Any]]:
        """
        登录后要弹的公告（#190）：看得见 · 弹窗 · 我没读；带正文（弹窗里直接显示）

        :param db: 数据库会话
        :param viewer: 看的人
        :return:
        """
        items = [_feed_item(n, content=True) for n in await notice_dao.get_popups(db, viewer, POPUP_LIMIT)]
        await _decorate_for_reader(db, viewer, items)
        return items

    @staticmethod
    async def get_banner(*, db: AsyncSession, viewer: Viewer) -> list[dict[str, Any]]:
        """
        横幅（#190）：看得见 · 置顶 · 紧急 · 我没读。不带正文；关掉 = 标已读

        :param db: 数据库会话
        :param viewer: 看的人
        :return:
        """
        rows = await notice_dao.get_banner(db, viewer, NoticeLevel.URGENT.value, BANNER_LIMIT)
        items = _rows_to_dicts(rows)
        await _decorate_for_reader(db, viewer, items)
        return items

    @staticmethod
    async def get_public(*, db: AsyncSession) -> list[dict[str, Any]]:
        """
        登录页的公告（#190，不登录也能看）：发出去了 · 登录页可见 · 没有发布范围。只给纯文本摘要

        :param db: 数据库会话
        :return:
        """
        return [
            {
                'id': row.id,
                'title': row.title,
                'level': row.level,
                'pinned': row.pinned,
                'publish_time': row.publish_time,
                'created_time': row.created_time,
                'summary': plain_summary(row.content),
            }
            for row in await notice_dao.get_public(db, PUBLIC_LIMIT)
        ]

    @staticmethod
    async def get_reads(*, db: AsyncSession, pk: int, read: bool) -> dict[str, Any]:
        """
        阅读统计（#190）：已读的 / 未读的（发布范围内、启用的账号里还没读的），分页 + 两边的人数

        - 已读 = 现在挂着的那一行收件箱行上有已读标记的人（带阅读时间）
        - 未读 = 发布范围内（部门含下级、启用的角色）、启用的、没删的账号里没有已读标记的人；
          建号晚于发布的不算未读（新账号规则，同收件箱），**必须确认的除外**（新来的也要点）
        - 还没有收件箱行（没到发布时间 / 隐藏 / 过期撤回了）：两边都是空的 —— 还没发到任何人手里

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :param read: True 看已读、False 看未读
        :return:
        """
        notice = await notice_dao.get(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        source = make_source(NOTICE_SOURCE, pk)
        row = await notification_dao.get_live_by_source(db, source)
        columns = (User.id.label('user_id'), User.username, User.nickname, Dept.name.label('dept_name'))
        dept_on = and_(Dept.id == User.dept_id, Dept.deleted == 0)

        read_stmt = (
            select(*columns, NotificationRead.read_time)
            .select_from(NotificationRead)
            .join(User, User.id == NotificationRead.user_id)
            .outerjoin(Dept, dept_on)
            .where(NotificationRead.notification_id == row.id if row else false(), User.deleted == 0)
            .order_by(NotificationRead.read_time.desc(), User.id)
        )

        unread_stmt = select(*columns).select_from(User).outerjoin(Dept, dept_on).order_by(User.id)
        if row is None:
            unread_stmt = unread_stmt.where(false())
        else:
            in_audience = await audience_user_clause(db, source)
            has_read = (
                select(NotificationRead.id)
                .where(NotificationRead.notification_id == row.id, NotificationRead.user_id == User.id)
                .exists()
            )
            unread_stmt = unread_stmt.where(User.deleted == 0, User.status == StatusType.enable, ~has_read)
            if in_audience is not None:
                unread_stmt = unread_stmt.where(in_audience)
            # 「必须确认」只认还发着的（同收件箱那一侧，`crud_notice.must_ack_inbox_rows`）：
            # 过期了、任务还没撤回那一行时，它已经是普通的一行，新账号规则照常
            if not (notice.require_ack and _is_live(notice.status, notice.expire_time, notice.publish_time)):
                # 新账号规则（同 `crud_notification.implicitly_read`）：发布之后才建的号对这一行算已读
                unread_stmt = unread_stmt.where(User.join_time <= row.created_time)

        page_data = await paging_data(db, read_stmt if read else unread_stmt, transformer=_rows_to_dicts)
        # 当前页签的人数分页已经数过了（`total`），只另数另一个页签
        other = await count_rows(db, unread_stmt if read else read_stmt)
        page_data['read_count'], page_data['unread_count'] = (
            (page_data['total'], other) if read else (other, page_data['total'])
        )
        return page_data

    @staticmethod
    async def get_all(*, db: AsyncSession) -> Sequence[Notice]:
        """
        获取所有通知公告

        :param db: 数据库会话
        :return:
        """

        notices = await notice_dao.get_all(db)
        return notices

    @staticmethod
    async def create(*, db: AsyncSession, user: Any, obj: CreateNoticeParam) -> dict[str, Any]:
        """
        创建通知公告，返回创建出来的对象（前端要用 id 去挂正文里的内联图）

        顺序是「建公告 → 发布范围 → 挂附件 → 发广播」，同一个事务：读者收到通知时附件已经在了，
        附件校验不过整条回滚，不会发出一条「附件挂一半」的公告

        :param db: 数据库会话
        :param user: 操作人
        :param obj: 创建通知公告参数
        :return:
        """
        audience = normalize_audience([(e.kind, e.target_id) for e in obj.audience or []])
        _check_combination(popup=obj.popup, require_ack=obj.require_ack, public=obj.public, has_audience=bool(audience))
        if audience:
            await _check_audience_targets(db, audience)

        notice = await notice_dao.create(db, obj)
        if audience:
            await notification_audience_dao.replace(db, make_source(NOTICE_SOURCE, notice.id), audience)
        if obj.attachment_ids:
            await _sync_attachments(db, user=user, pk=notice.id, file_ids=obj.attachment_ids)
        # 建出来就已经过期的不发（读者点进去是 404）；定了未来发布时间的交给定时任务 `notice.sync_inbox`
        if _is_live(notice.status, notice.expire_time, notice.publish_time):
            await _broadcast(db, notice.id, notice.title, restricted=bool(audience))
        item = _columns(notice)
        await _decorate_for_admin(db, [item])
        return item

    @staticmethod
    async def update(*, db: AsyncSession, user: Any, pk: int, obj: UpdateNoticeParam) -> int:
        """
        更新通知公告

        收件箱那一行按「现在该不该被看见」对齐，见 `_align_inbox`

        🔴 **先锁住这条公告**（和定时任务 `publish_scheduled` / `retract_stale` 同一把锁），再读「有没有挂着的行」：
        不锁的话，任务（或者同一个编辑点了两下的第一次）已经判过「没有行」、正停在广播里还没提交，这边读到的也是
        「没有行」，于是各发一行 —— 铃铛里同一条出现两次；弹窗看「任一行未读」、`notification_id` 给的却是最新那行，
        必须确认的点了「我已阅读」标掉的是新行，旧行还未读，弹窗永远关不掉。
        锁要是这个事务里的**第一条**语句：MySQL 的可重复读在第一次普通读时定快照，锁之前读过就看不见对方刚提交的行

        :param db: 数据库会话
        :param user: 操作人
        :param pk: 通知公告 ID
        :param obj: 更新通知公告参数
        :return:
        """

        notice = await notice_dao.lock(db, pk)
        if notice is None or notice.deleted != 0:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        source = make_source(NOTICE_SOURCE, pk)
        fields = obj.model_fields_set

        # 生效后的值：没传的按库里原值（crud 按 `exclude_unset` 写，不能拿入参的默认值当「清掉」算）。
        # 改之前抓成局部变量：`notice` 和 update 动的是同一个 ORM 实例，改完再读就是新值（apps/api 分册）
        def effective(name: str) -> Any:
            return getattr(obj, name) if name in fields else getattr(notice, name)

        status, expire_time, publish_time = effective('status'), effective('expire_time'), effective('publish_time')
        popup, require_ack, public = effective('popup'), effective('require_ack'), effective('public')
        old_title = notice.title

        current = (await notification_audience_dao.get_by_sources(db, [source])).get(source, [])
        wanted = (
            normalize_audience([(e.kind, e.target_id) for e in obj.audience]) if obj.audience is not None else current
        )
        _check_combination(popup=popup, require_ack=require_ack, public=public, has_audience=bool(wanted))
        if obj.audience is not None:
            await _check_audience_targets(db, wanted)
        live_row = await notification_dao.get_live_by_source(db, source)

        count = await notice_dao.update(db, pk, obj)
        audience_changed = obj.audience is not None and set(wanted) != set(current)
        if audience_changed:
            await notification_audience_dao.replace(db, source, wanted)
        if obj.attachment_ids is not None:
            await _sync_attachments(db, user=user, pk=pk, file_ids=obj.attachment_ids)

        await _align_inbox(
            db,
            pk,
            title=obj.title,
            old_title=old_title,
            shown=_is_live(status, expire_time, publish_time),
            live_row=live_row.id if live_row is not None else None,
            restricted=bool(wanted),
            audience_changed=audience_changed,
            widened=audience_changed and bool(current) and not wanted,
        )
        return count

    @staticmethod
    async def delete(*, db: AsyncSession, obj: DeleteNoticeParam) -> int:
        """
        批量删除通知公告

        :param db: 数据库会话
        :param obj: 通知公告 ID 列表
        :return:
        """

        count = await notice_dao.delete(db, obj.pks)
        # (issue #63) 只删公告本身不够——挂在它上面的附件/内联图关联要一并
        # 解除，否则 sys_file_relation 里留着指向已删公告的行，永久占用
        # /sys/files/statistics 的计数，且 GET /sys/files/targets/{type}/{id}
        # 不检查目标是否存在，任何登录用户仍能查到"已删除"公告的附件列表。
        # 这里只解关联、不删底层 sys_file——和现有的 detach 接口
        # （DELETE /sys/files/relations）同一套语义：卸载不等于销毁文件，
        # 万一同一份文件被挂在别处（复制粘贴同一张图）不会被连带删掉。
        for pk in obj.pks:
            for target_type in _NOTICE_TARGET_TYPES:
                file_ids = await file_relation_dao.get_file_ids_by_target(db, target_type, pk)
                if file_ids:
                    await file_relation_dao.delete_by_target(db, target_type, pk, list(file_ids))
            await _retract(db, pk)
            # 受众行是公告的一部分（硬删，#190）
            await notification_audience_dao.delete_by_source(db, make_source(NOTICE_SOURCE, pk))
        return count

    @staticmethod
    async def publish_scheduled(*, db: AsyncSession, pk: int) -> bool:
        """
        定时任务：一条到了发布时间的公告发出去（#190）。调用方提交；推送挂在提交之后

        🔴 先**锁住这条公告再重新判一遍**：列表是锁之前取的，取完到这里之间可能被改成隐藏、
        也可能另一个 worker 刚发完。锁住之后再看「还该发、还没有挂着的行」才发 —— 重复跑、并发跑都只发一次

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return: 这次是不是发了
        """
        notice = await notice_dao.lock(db, pk)
        if (
            notice is None
            or notice.deleted != 0
            or notice.publish_time is None
            or not _is_live(notice.status, notice.expire_time, notice.publish_time)
        ):
            return False
        source = make_source(NOTICE_SOURCE, pk)
        if await notification_dao.get_live_by_source(db, source) is not None:
            return False
        restricted = bool((await notification_audience_dao.get_by_sources(db, [source])).get(source))
        await _broadcast(db, pk, notice.title, restricted=restricted)
        return True

    @staticmethod
    async def retract_stale(*, db: AsyncSession, pk: int) -> bool:
        """
        定时任务：一条读者已经看不见了（过期为主）、收件箱行还挂着的公告，把那一行撤回（#190）

        #186 时「自然过期不撤回」（没有事件可挂），点进去是「已撤回或已过期」；现在由任务每分钟扫一次

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return: 这次是不是撤了
        """
        notice = await notice_dao.lock(db, pk)
        if (
            notice is not None
            and notice.deleted == 0
            and _is_live(notice.status, notice.expire_time, notice.publish_time)
        ):
            return False
        return bool(await _retract(db, pk))


notice_service: NoticeService = NoticeService()
