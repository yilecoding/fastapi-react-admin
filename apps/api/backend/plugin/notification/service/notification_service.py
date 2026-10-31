from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.after_commit import run_after_commit
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.common.socketio.actions import notification_new
from backend.core.conf import settings
from backend.plugin.notification.audience import Viewer
from backend.plugin.notification.crud.crud_notification import implicit_read_time, notification_dao
from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.kinds import NotificationKind, require_notification_kind
from backend.plugin.notification.model import Notification
from backend.plugin.notification.schema.notification import (
    CreateNotificationParam,
    SendNotificationParam,
)
from backend.plugin.notification.sources import count_source_attachments


async def _push(user_id: int | None) -> None:
    """推一条「有新的」事件。

    🔴 **推送失败不能让写入失败**。通知已经落库了，未读数下一次 REST 调用照样
    拿得到正确值（登录时那次就够）；这里往上抛只会把「实时性没到」升级成
    「这条通知根本没发出去」。socket 在这套设计里是尽力而为的加速层，不是送达保证。
    """
    try:
        await notification_new(user_id)
    except Exception as e:
        log.warning(f'站内通知推送失败（不影响入库）：{e!s}')


def push_broadcast_after_commit(db: AsyncSession) -> None:
    """让所有在线的人重拉收件箱，挂到调用方提交之后（#186）。广播新写一行、撤回一行、改一行的标题都要它

    🔴 原来广播是写完那一行当场推：公告接口的提交在依赖收尾，铃铛收到推送立刻重拉未读数，
    读到的还是提交前的旧数（`Dispatch` 的注释早就写着这一条，广播这条路漏了）。回滚就不推。
    事件名是 `notification:new`，但前端收到只是重拉 —— 撤回也用它，不另开一个事件
    """
    run_after_commit(db, 'notification.push_broadcast', lambda: _push(None))


@dataclass
class Dispatch:
    """`create_in_tx` 的结果：事务提交**之后**要做的两件事（socket 推送 · 踢投递 worker）

    分开交给调用方，是因为提交在调用方手里：审批流把它们挂进 `ctx.effects`，单条通知在这里提交完自己跑。
    推送先于提交到达的话，前端拉到的未读数是旧的；踢早了 worker 读不到投递行。
    """

    notifications: list[Notification] = field(default_factory=list)
    #: 要推「有新的」的人（None = 广播）
    push_user_ids: list[int | None] = field(default_factory=list)
    #: 写了几行待发的投递（> 0 才踢 worker）
    pending: int = 0

    async def after_commit(self) -> None:
        for uid in dict.fromkeys(self.push_user_ids):
            await _push(uid)
        if self.pending:
            from backend.plugin.notification.service.delivery_service import kick

            await kick()


async def create_in_tx(
    db: AsyncSession,
    *,
    kind: str,
    user_ids: Sequence[int],
    title: str,
    content: str,
    link: str | None = None,
    category: NotificationCategory | None = None,
) -> Dispatch:
    """在调用方的事务里写站内行 + 按路由写外部渠道的投递行（#166）。不 commit、不推送。

    🔴 这是**唯一**写通知的入口（`notify` / `send` 和审批流都走它）。新的调用方另写一份「写行 + 发邮件」，
    第四个调用方一定会漏掉其中一半（硬纪律 9 在列表页漏过 12 次，同一个物种）。

    :param kind: 通知类型码（`register_notification_kind` 注册过的）；没注册当场抛 LookupError —— 那是调用方的 bug
    :param category: 不给就用类型声明的分类
    """
    from backend.plugin.notification.service.bot_service import enqueue_bots
    from backend.plugin.notification.service.config import load_notification_config
    from backend.plugin.notification.service.delivery_service import enqueue
    from backend.plugin.notification.service.routing import resolve

    spec = require_notification_kind(kind)
    if spec.broadcast:
        raise ValueError(f'通知类型 {kind} 是全员广播，用 broadcast()')
    out = Dispatch()
    uids = list(dict.fromkeys(user_ids))
    if not uids:
        return out

    ids: dict[int, int] = {}
    if spec.writes_inbox:
        for uid in uids:
            row = await notification_dao.create(
                db,
                CreateNotificationParam(
                    title=title[:128],
                    content=content,
                    category=category if category is not None else spec.category,
                    link=link,
                    recipient_id=uid,
                ),
            )
            ids[uid] = row.id
            out.notifications.append(row)
            out.push_user_ids.append(uid)

    await load_notification_config(db)
    if settings.NOTIFICATION_EXTERNAL_ENABLED:
        routes = await resolve(db, spec, uids)
        out.pending = enqueue(
            db, kind=spec, routes=routes, title=title, content=content, link=link, notification_ids=ids
        )
        # 群机器人（#166 二期）：一条通知一个群一行，和收件人有几个无关
        out.pending += await enqueue_bots(db, kind=spec, title=title, content=content, link=link)
    return out


async def _push_to_bots(
    db: AsyncSession, spec: NotificationKind, *, notification_id: int, title: str, content: str, link: str | None
) -> int:
    """一条广播推给订阅了它的群机器人：一个群一行投递（挂着站内那一行的 ID），提交之后踢 worker。不 commit

    提交在调用方手里（公告接口是依赖收尾时提交）：踢挂到会话的 after_commit 上，回滚就不踢
    """
    from backend.plugin.notification.service.bot_service import enqueue_bots
    from backend.plugin.notification.service.config import load_notification_config
    from backend.plugin.notification.service.delivery_service import kick_after_commit

    await load_notification_config(db)
    if not settings.NOTIFICATION_EXTERNAL_ENABLED:
        return 0
    n = await enqueue_bots(db, kind=spec, title=title, content=content, link=link, notification_id=notification_id)
    if n:
        kick_after_commit(db)
    return n


class NotificationService:
    """站内通知服务类"""

    @staticmethod
    async def get_list(
        *, db: AsyncSession, viewer: Viewer, title: str | None, category: int | None, unread: bool | None
    ) -> dict[str, Any]:
        """
        获取「我的通知」分页列表

        :param db: 数据库会话
        :param viewer: 看的人（`audience.viewer_of(db, request.user)`）
        :param title: 标题（模糊匹配）
        :param category: 分类
        :param unread: True 只看未读、False 只看已读、None 不筛
        :return:
        """
        select = await notification_dao.get_select(viewer, title, category, unread=unread)
        page_data = await paging_data(db, select)

        # 已读状态**不是** `sys_notification` 上的列（广播不 fan-out，见模型注释），
        # 所以只能分页拿到这一页之后再补一次查询回填。放在 service 而不是 crud：
        # 它改的是 DTO，不是查询。
        #
        # ⚠️ `paging_data()` 里那句 `paginated_data.model_dump()` 已经把 ORM 实例
        # **变成了 dict** —— 模型是 `MappedAsDataclass`，pydantic 的 dump 会照
        # dataclass 展开它。这里按属性取（`item.id`）会直接
        # `'dict' object has no attribute 'id'` → 500（实测踩过）。
        items: list[dict[str, Any]] = list(page_data['items'])
        read_map = await notification_dao.get_read_map(db, viewer.id, [i['id'] for i in items])
        attachments = await count_source_attachments(db, [i.get('source') for i in items], viewer)
        needs_ack = await notification_dao.get_explicit_ack_ids(db, [i['id'] for i in items])
        for item in items:
            # 必须读者打开确认的（#190 公告的「必须确认」）：前端那一行不摆「标为已读」，「全部已读」也跳过它
            item['requires_ack'] = item['id'] in needs_ack
            # 没有显式已读、但是建号之前的广播：按新账号规则算已读，阅读时间回填成建号时间（同 `_unread` 的判定，
            # 必须确认的除外 —— 新来的人也要点「我已阅读」）
            item['read_time'] = read_map.get(item['id']) or implicit_read_time(
                viewer,
                recipient_id=item['recipient_id'],
                created_time=item['created_time'],
                requires_ack=item['requires_ack'],
            )
            item['attachment_count'] = attachments.get(item.get('source') or '')
        return page_data

    @staticmethod
    async def get_unread(*, db: AsyncSession, viewer: Viewer) -> dict[str, Any]:
        """
        获取未读数（红点用）

        :param db: 数据库会话
        :param viewer: 看的人
        :return:
        """
        by_category, requires_ack = await notification_dao.count_unread(db, viewer)
        return {
            'total': sum(by_category.values()),
            # 「全部已读」会跳过它们：前端拿 `total - requires_ack_count` 判按钮还有没有东西可标
            'requires_ack_count': requires_ack,
            # key 转成字符串：JSON 对象的 key 本来就只能是字符串，
            # 这里显式转一次，免得前端拿到 `{0: 3}` 之后按数字下标去取
            'by_category': {str(k): v for k, v in by_category.items()},
        }

    @staticmethod
    async def mark_read(*, db: AsyncSession, viewer: Viewer, pk: int) -> int:
        """
        标记单条已读（幂等）

        :param db: 数据库会话
        :param viewer: 看的人
        :param pk: 通知 ID
        :return:
        """
        # 🔴 看不见的通知不能标已读 —— 否则 `sys_notification_read` 会长出
        # 「A 读过一条只发给 B 的通知」这种行，等于用一个写接口泄漏了「这条 ID 存在」。
        # 判定和列表同一个 `visible_to`（#190 起广播也有受众了，只比 `recipient_id` 不够）
        notification = await notification_dao.get_visible(db, viewer, pk)
        if not notification:
            raise errors.NotFoundError(msg=t('error.notification.not_found'))
        return await notification_dao.mark_read(db, viewer.id, [pk])

    @staticmethod
    async def mark_all_read(*, db: AsyncSession, viewer: Viewer) -> int:
        """
        标记全部已读 —— **跳过必须读者打开确认的**（`notification_dao.get_unread_ids`），那些只能逐条 `mark_read`

        :param db: 数据库会话
        :param viewer: 看的人
        :return:
        """
        pks = await notification_dao.get_unread_ids(db, viewer)
        return await notification_dao.mark_read(db, viewer.id, pks)

    @staticmethod
    async def send(*, db: AsyncSession, obj: SendNotificationParam) -> int:
        """
        管理端手动发送

        :param db: 数据库会话
        :param obj: 发送参数
        :return: 落库的通知条数
        """
        recipients = list(dict.fromkeys(obj.recipient_ids))
        if not recipients:
            # 全员广播：一行、不 fan-out，只走站内（外部渠道广播 = 全员群发，一期不开这个口子）
            await notification_dao.create(db, CreateNotificationParam(**obj.model_dump(exclude={'recipient_ids'})))
            await db.commit()
            await _push(None)
            return 1
        dispatch = await create_in_tx(
            db,
            kind='system',
            user_ids=recipients,
            title=obj.title,
            content=obj.content,
            link=obj.link,
            category=obj.category,
        )
        await db.commit()
        await dispatch.after_commit()
        return len(recipients)

    @staticmethod
    async def broadcast(
        *,
        db: AsyncSession,
        title: str,
        content: str,
        link: str | None = None,
        category: NotificationCategory | None = None,
        kind: str = 'announcement',
        source: str | None = None,
        to_bots: bool = True,
    ) -> Notification:
        """
        发一条全员广播（给别的模块调用，比如公告发布 / 每日问候）。站内一行，不走邮件 / 短信（那等于全员群发）；
        类型声明了 `bot=True` 的，订阅了它的群机器人各一行投递（#166 二期）。踢 worker 和 socket 推送都在
        **调用方提交之后**

        :param db: 数据库会话
        :param title: 标题
        :param content: 内容
        :param link: 点击跳转的前端路由
        :param category: 分类，不给就用类型声明的分类
        :param kind: 通知类型码，必须是声明了 `broadcast=True` 的
        :param source: 来源业务对象（`sources.make_source`），要反查 / 撤回这一行的调用方给
        :param to_bots: 是否推给订阅了这个类型的群机器人。🔴 **有受众限制的来源要传 False**（#190）：
            群机器人发进的是一整个群，管不了「只给技术中心看」—— 推过去就是把限定范围的公告发给了群里所有人
        :return:
        """
        spec = require_notification_kind(kind)
        if not spec.broadcast:
            raise ValueError(f'通知类型 {kind} 不是广播类型，用 notify()')
        category = category if category is not None else spec.category
        notification = await notification_dao.create(
            db,
            CreateNotificationParam(
                title=title,
                content=content,
                category=category,
                link=link,
                recipient_id=None,
                source=source,
            ),
        )
        if spec.bot and to_bots:
            await _push_to_bots(db, spec, notification_id=notification.id, title=title, content=content, link=link)
        push_broadcast_after_commit(db)
        return notification

    @staticmethod
    async def broadcast_to_bots(
        *,
        db: AsyncSession,
        notification_id: int,
        title: str,
        content: str,
        link: str | None = None,
        kind: str = 'announcement',
    ) -> int:
        """
        给一条**已经在收件箱里**的广播补推群机器人（#190）：公告发布时有发布范围、没推群（`to_bots=False`），
        之后范围放宽成全员。站内那一行不重写；这一行推过群（有它的机器人投递行）就不再推 ——
        全员 → 限定 → 全员，群里不能出现两次。提交之后踢 worker，同 `broadcast`

        :param db: 数据库会话
        :param notification_id: 站内那一行广播
        :param title: 标题
        :param content: 内容
        :param link: 点击跳转的前端路由
        :param kind: 通知类型码，必须是声明了 `broadcast=True` 的
        :return: 写了几行机器人投递
        """
        from backend.plugin.notification.crud.crud_channel import notification_delivery_dao

        spec = require_notification_kind(kind)
        if not spec.broadcast:
            raise ValueError(f'通知类型 {kind} 不是广播类型')
        if not spec.bot or await notification_delivery_dao.has_bot_delivery(db, notification_id):
            return 0
        return await _push_to_bots(db, spec, notification_id=notification_id, title=title, content=content, link=link)

    @staticmethod
    async def notify(
        *,
        db: AsyncSession,
        user_id: int,
        title: str,
        content: str,
        link: str | None = None,
        category: NotificationCategory | None = None,
        kind: str = 'system',
    ) -> Notification | None:
        """
        发给某一个人（给别的模块调用，比如后台导出完成）。站内 + 按策略和本人偏好走外部渠道（#166）。

        ⚠️ 调用方负责 commit，推送在这里立刻发 —— 所以要在**提交之后**调用，或者调用方自己的
        会话马上提交：推送先到、行还没提交时，前端拉到的未读数是旧的（下一次拉取会对，只是慢一拍）

        :param db: 数据库会话
        :param user_id: 接收人
        :param title: 标题
        :param content: 内容
        :param link: 点击跳转的前端路由
        :param category: 分类，不给就用类型声明的分类
        :param kind: 通知类型码
        :return: 站内那一行（类型不写站内时为 None）
        """
        dispatch = await create_in_tx(
            db, kind=kind, user_ids=[user_id], title=title, content=content, link=link, category=category
        )
        await db.commit()
        await dispatch.after_commit()
        return dispatch.notifications[0] if dispatch.notifications else None


notification_service: NotificationService = NotificationService()
