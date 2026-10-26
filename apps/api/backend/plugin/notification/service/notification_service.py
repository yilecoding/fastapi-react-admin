from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.common.socketio.actions import notification_new
from backend.core.conf import settings
from backend.plugin.notification.crud.crud_notification import notification_dao
from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.kinds import require_notification_kind
from backend.plugin.notification.model import Notification
from backend.plugin.notification.schema.notification import (
    CreateNotificationParam,
    SendNotificationParam,
)


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
    return out


class NotificationService:
    """站内通知服务类"""

    @staticmethod
    async def get_list(
        *, db: AsyncSession, user_id: int, title: str | None, category: int | None, unread: bool | None
    ) -> dict[str, Any]:
        """
        获取「我的通知」分页列表

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :param title: 标题（模糊匹配）
        :param category: 分类
        :param unread: True 只看未读、False 只看已读、None 不筛
        :return:
        """
        select = await notification_dao.get_select(user_id, title, category, unread=unread)
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
        read_map = await notification_dao.get_read_map(db, user_id, [i['id'] for i in items])
        for item in items:
            item['read_time'] = read_map.get(item['id'])
        return page_data

    @staticmethod
    async def get_unread(*, db: AsyncSession, user_id: int) -> dict[str, Any]:
        """
        获取未读数（红点用）

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :return:
        """
        by_category = await notification_dao.count_unread_by_category(db, user_id)
        return {
            'total': sum(by_category.values()),
            # key 转成字符串：JSON 对象的 key 本来就只能是字符串，
            # 这里显式转一次，免得前端拿到 `{0: 3}` 之后按数字下标去取
            'by_category': {str(k): v for k, v in by_category.items()},
        }

    @staticmethod
    async def mark_read(*, db: AsyncSession, user_id: int, pk: int) -> int:
        """
        标记单条已读（幂等）

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :param pk: 通知 ID
        :return:
        """
        notification = await notification_dao.get(db, pk)
        # 🔴 看不见的通知不能标已读 —— 否则 `sys_notification_read` 会长出
        # 「A 读过一条只发给 B 的通知」这种行，等于用一个写接口泄漏了「这条 ID 存在」
        if not notification or (notification.recipient_id is not None and notification.recipient_id != user_id):
            raise errors.NotFoundError(msg=t('error.notification.not_found'))
        return await notification_dao.mark_read(db, user_id, [pk])

    @staticmethod
    async def mark_all_read(*, db: AsyncSession, user_id: int) -> int:
        """
        标记全部已读

        :param db: 数据库会话
        :param user_id: 当前用户 ID
        :return:
        """
        pks = await notification_dao.get_unread_ids(db, user_id)
        return await notification_dao.mark_read(db, user_id, pks)

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
    ) -> Notification:
        """
        发一条全员广播（给别的模块调用，比如公告发布 / 每日问候）。只写站内（#166：广播一期不走外部渠道）

        :param db: 数据库会话
        :param title: 标题
        :param content: 内容
        :param link: 点击跳转的前端路由
        :param category: 分类，不给就用类型声明的分类
        :param kind: 通知类型码，必须是声明了 `broadcast=True` 的
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
            ),
        )
        await _push(None)
        return notification

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
