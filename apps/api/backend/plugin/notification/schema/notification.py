from datetime import datetime

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase
from backend.plugin.notification.enums import NotificationCategory


class NotificationSchemaBase(SchemaBase):
    """站内通知基础模型"""

    title: str = Field(description='标题', max_length=128)
    content: str = Field(description='内容')
    category: NotificationCategory = Field(description='分类（0：系统、1：公告、2：任务事件）')
    link: str | None = Field(None, description='点击跳转的前端路由', max_length=256)


class CreateNotificationParam(NotificationSchemaBase):
    """创建站内通知参数（服务端内部用）"""

    recipient_id: int | None = Field(None, description='接收人 ID（为空表示全员广播）')


class SendNotificationParam(NotificationSchemaBase):
    """管理端手动发送站内通知参数

    ⚠️ 和 `CreateNotificationParam` 分开是刻意的：这个是**接口入参**，
    合成一个的话「全员广播」就变成了一个接口调用方随手能省掉的字段
    （不传 = 发给所有人），而那正是最该显式写出来的那种意图。
    """

    recipient_ids: list[int] = Field(default_factory=list, description='接收人 ID 列表；留空表示全员广播')


class GetNotificationDetail(NotificationSchemaBase):
    """站内通知详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='通知 ID')
    recipient_id: int | None = Field(None, description='接收人 ID（为空表示全员广播）')
    created_time: datetime = Field(description='创建时间')
    # 由 service 在分页之后按 `sys_notification_read` 回填 —— 不是数据库列。
    # 前端只认它：有值即已读。
    read_time: datetime | None = Field(None, description='阅读时间（为空表示未读）')


class GetNotificationUnreadDetail(SchemaBase):
    """未读数（给红点用的轻量接口）"""

    total: int = Field(description='未读总数')
    by_category: dict[str, int] = Field(description='按分类拆开的未读数，key 是分类数值的字符串形式')
