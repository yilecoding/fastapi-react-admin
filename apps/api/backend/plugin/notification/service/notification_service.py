from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.common.pagination import paging_data
from backend.common.socketio.actions import notification_new
from backend.plugin.notification.crud.crud_notification import notification_dao
from backend.plugin.notification.enums import NotificationCategory
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
        recipients: list[int | None] = list(dict.fromkeys(obj.recipient_ids)) or [None]
        base = obj.model_dump(exclude={'recipient_ids'})
        for recipient_id in recipients:
            await notification_dao.create(db, CreateNotificationParam(**base, recipient_id=recipient_id))
            await _push(recipient_id)
        return len(recipients)

    @staticmethod
    async def broadcast(
        *,
        db: AsyncSession,
        title: str,
        content: str,
        link: str | None = None,
        category: NotificationCategory = NotificationCategory.ANNOUNCEMENT,
    ) -> Notification:
        """
        发一条全员广播（给别的模块调用，比如公告发布 / 每日问候）

        :param db: 数据库会话
        :param title: 标题
        :param content: 内容
        :param link: 点击跳转的前端路由
        :param category: 分类，默认「公告」——调用方不传就是原来的行为
        :return:
        """
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


notification_service: NotificationService = NotificationService()
