from collections.abc import Sequence
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_file import file_dao, file_relation_dao
from backend.app.admin.model import File, FileRelation
from backend.app.admin.service.file_service import file_service, register_file_access, register_relation_guard
from backend.common.enums import StatusType
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.common.security.data_scope import bypass_data_scope
from backend.common.security.rbac import user_has_perm
from backend.core.conf import settings
from backend.plugin.notice.crud.crud_notice import notice_dao, readable_clause
from backend.plugin.notice.model import Notice
from backend.plugin.notice.schema.notice import CreateNoticeParam, DeleteNoticeParam, UpdateNoticeParam
from backend.plugin.notification.crud.crud_notification import notification_dao
from backend.plugin.notification.service.notification_service import (
    notification_service,
    push_broadcast_after_commit,
)
from backend.plugin.notification.sources import make_source, register_source_attachments
from backend.utils.timezone import timezone

#: 一条公告挂着两种独立的附件关系（前端 `pages/notice/api.ts` 的常量）：
#: `NOTICE` 是"附件"面板，`NOTICE_CONTENT` 是正文里的内联图。两者都要在
#: 公告删除时一并解除关联，否则 (issue #63) 已删除公告的图片仍能通过
#: `GET /sys/files/targets/{target_type}/{target_id}` 被任意登录用户查到。
NOTICE_ATTACHMENT_TARGET = 'NOTICE'
_NOTICE_TARGET_TYPES = (NOTICE_ATTACHMENT_TARGET, 'NOTICE_CONTENT')

#: 收件箱行的来源类型（`sys_notification.source = 'notice:<id>'`）
NOTICE_SOURCE = 'notice'


def notice_link(pk: int) -> str:
    """收件箱 / 群机器人里那条公告指向哪：消息中心就地打开这一条（任何登录用户都进得去）

    🔴 原来是 `/plugins/notice` —— 管理页，路由守卫要 `sys:notice:add`，普通用户点进去是 403，
    而且点这一下已经把它标成已读了（#186 实测）。群机器人卡片里的链接也是它
    """
    return f'/notification?notice={pk}'


def _is_live(status: int, expire_time: datetime | None) -> bool:
    """显示中、没过期 —— 同 `readable_clause()`，给还没落库 / 刚改完的值判一次

    入参里的时间可能不带时区（`2026-11-01 18:00:00`），和带时区的 now 比会 TypeError；
    按应用时区补上标记，同 `TimeZone.process_bind_param` 对 naive 值的处理
    """
    if expire_time is not None and expire_time.tzinfo is None:
        expire_time = expire_time.replace(tzinfo=timezone.tz_info)
    return status == StatusType.enable and (expire_time is None or expire_time > timezone.now())


def _can_manage(user: Any) -> bool:
    """管理端的人（能进管理页的）隐藏 / 过期的也看得到 —— 编辑时要预览附件"""
    return user_has_perm(user, 'sys:notice:add') or user_has_perm(user, 'sys:notice:edit')


async def _notice_file_access(db: AsyncSession, user: Any, file: Any) -> bool:
    """挂在公告上的附件 / 正文图：**看得见这条公告，才打得开它的附件**（#186）

    🔴 原来只看「公告没删」，于是隐藏的公告附件照样下得到（实测 200），而列表上已经看不见了。
    现在和读者列表用同一个 `readable_clause()`；管理端的人对没删的都放行（编辑表单里要预览）
    """
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
    stmt = stmt.where(Notice.deleted == 0) if _can_manage(user) else stmt.where(readable_clause())
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


async def _count_readable_attachments(db: AsyncSession, pks: Sequence[int]) -> dict[int, int]:
    """收件箱那边按来源要附件数：读者看不见的公告不报数（隐藏之后行会被撤回，这里是兜底）"""
    readable = list((await db.scalars(select(Notice.id).where(Notice.id.in_(list(pks)), readable_clause()))).all())
    return await _count_attachments(db, readable)


register_source_attachments(NOTICE_SOURCE, _count_readable_attachments)


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


async def _broadcast(db: AsyncSession, notice: Notice, title: str) -> None:
    """公告发布时顺带往站内收件箱写一条全员广播，带上来源，好反查 / 撤回"""
    await notification_service.broadcast(
        db=db,
        title=title,
        content=_summary(title),
        link=notice_link(notice.id),
        kind='announcement',
        source=make_source(NOTICE_SOURCE, notice.id),
    )


async def _retract(db: AsyncSession, pk: int) -> None:
    """公告隐藏 / 删除：收件箱那一行一起撤回，不然标题还挂在所有人的铃铛里、点进去是「不存在」

    撤回了就要推一次：不推的话在线的人红点里还数着这一行，点进去是「已撤回」，要等下一次重拉才对
    """
    if await notification_dao.retract_by_source(db, make_source(NOTICE_SOURCE, pk)):
        push_broadcast_after_commit(db)


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


async def _decorate_for_reader(db: AsyncSession, user_id: int, items: list[dict[str, Any]]) -> None:
    """给读者那一份补上附件数 · 收件箱行 · 读没读（原地改 dict）"""
    pks = [item['id'] for item in items]
    counts = await _count_attachments(db, pks)
    rows = await notification_dao.get_ids_by_sources(db, [make_source(NOTICE_SOURCE, pk) for pk in pks])
    read_map = await notification_dao.get_read_map(db, user_id, list(rows.values()))
    for item in items:
        nid = rows.get(make_source(NOTICE_SOURCE, item['id']))
        item['attachment_count'] = counts.get(item['id'], 0)
        item['notification_id'] = nid
        # 没有收件箱行的（#186 之前发的、对不上的）算已读：没有能标已读的东西，标成未读就永远是红点
        item['read'] = nid is None or nid in read_map


class NoticeService:
    """通知公告服务类"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> Notice:
        """
        获取通知公告（管理端）

        :param db: 数据库会话
        :param pk: 通知公告 ID
        :return:
        """

        notice = await notice_dao.get(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        return notice

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
        return await paging_data(db, notice_select)

    @staticmethod
    async def get_feed(*, db: AsyncSession, user_id: int) -> dict[str, Any]:
        """
        给所有登录用户看的公告列表（工作台 / 移动端首页）：只有显示中、没过期的，置顶在前

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :return:
        """
        page_data = await paging_data(db, notice_dao.get_feed_select())
        # `paging_data` 的 items 已经是 dict（apps/api 分册「paging_data() 返回的 items 是 dict」）
        await _decorate_for_reader(db, user_id, list(page_data['items']))
        return page_data

    @staticmethod
    async def get_feed_detail(*, db: AsyncSession, user_id: int, pk: int) -> dict[str, Any]:
        """
        给所有登录用户看的公告详情。隐藏 / 过期 / 删了的一律 404（不区分，不泄露「这条存在」）

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :param pk: 通知公告 ID
        :return:
        """
        notice = await notice_dao.get_readable(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        item = {
            'id': notice.id,
            'title': notice.title,
            'type': notice.type,
            'pinned': notice.pinned,
            'level': notice.level,
            'expire_time': notice.expire_time,
            'created_time': notice.created_time,
            'updated_time': notice.updated_time,
            'content': notice.content,
        }
        await _decorate_for_reader(db, user_id, [item])
        return item

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
    async def create(*, db: AsyncSession, user: Any, obj: CreateNoticeParam) -> Notice:
        """
        创建通知公告，返回创建出来的对象（前端要用 id 去挂正文里的内联图）

        顺序是「建公告 → 挂附件 → 发广播」，同一个事务：读者收到通知时附件已经在了，
        附件校验不过整条回滚，不会发出一条「附件挂一半」的公告

        :param db: 数据库会话
        :param user: 操作人
        :param obj: 创建通知公告参数
        :return:
        """

        notice = await notice_dao.create(db, obj)
        if obj.attachment_ids:
            await _sync_attachments(db, user=user, pk=notice.id, file_ids=obj.attachment_ids)
        # 建出来就已经过期的不发：读者点进去是 404
        if _is_live(notice.status, notice.expire_time):
            await _broadcast(db, notice, notice.title)
        return notice

    @staticmethod
    async def update(*, db: AsyncSession, user: Any, pk: int, obj: UpdateNoticeParam) -> int:
        """
        更新通知公告

        :param db: 数据库会话
        :param user: 操作人
        :param pk: 通知公告 ID
        :param obj: 更新通知公告参数
        :return:
        """

        notice = await notice_dao.get(db, pk)
        if not notice:
            raise errors.NotFoundError(msg=t('error.notice.not_found'))
        # 改之前的值先抓成局部变量：`notice` 和 update 动的是同一个 ORM 实例，改完再读就是新值
        # （apps/api 分册「改完再读同一个 ORM 实例，读到的是新值」）
        was_shown = _is_live(notice.status, notice.expire_time)
        old_title = notice.title
        old_expire = notice.expire_time
        count = await notice_dao.update(db, pk, obj)
        if obj.attachment_ids is not None:
            await _sync_attachments(db, user=user, pk=pk, file_ids=obj.attachment_ids)
        # 没传 `expire_time` = 不改（crud 按 `exclude_unset` 写），不能拿入参的默认值 None 当「不过期」算
        expire_time = obj.expire_time if 'expire_time' in obj.model_fields_set else old_expire
        now_shown = _is_live(obj.status, expire_time)
        source = make_source(NOTICE_SOURCE, pk)
        if not was_shown and now_shown:
            # 「读者看不见 → 看得见」才算发布（隐藏改显示、把过期时间往后挪）。已经在显示的再存一次
            # 不重复推送 —— 否则改个错别字就给全员再发一遍红点。先撤一次：过期的那条可能还挂着
            await _retract(db, pk)
            await _broadcast(db, notice, obj.title)
        elif was_shown and not now_shown:
            await _retract(db, pk)
        elif now_shown and obj.title != old_title:
            # 还在显示、只改了标题：铃铛里那一行跟着改，不重新发
            if await notification_dao.update_by_source(db, source, title=obj.title, content=_summary(obj.title)):
                push_broadcast_after_commit(db)
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
        return count


notice_service: NoticeService = NoticeService()
