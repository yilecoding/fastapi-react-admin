from datetime import datetime

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase, SnowflakeIdIn
from backend.plugin.notification.enums import NotificationCategory


class NotificationSchemaBase(SchemaBase):
    """站内通知基础模型"""

    title: str = Field(description='标题', max_length=128)
    content: str = Field(description='内容')
    category: NotificationCategory = Field(description='分类（0：系统、1：公告、2：任务事件、3：审批）')
    link: str | None = Field(None, description='点击跳转的前端路由', max_length=256)


class CreateNotificationParam(NotificationSchemaBase):
    """创建站内通知参数（服务端内部用）"""

    recipient_id: SnowflakeIdIn | None = Field(None, description='接收人 ID（为空表示全员广播）')
    source: str | None = Field(None, description='来源业务对象（如 notice:123）', max_length=64)


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
    recipient_id: SnowflakeIdIn | None = Field(None, description='接收人 ID（为空表示全员广播）')
    created_time: datetime = Field(description='创建时间')
    # 由 service 在分页之后按 `sys_notification_read` 回填 —— 不是数据库列。
    # 前端只认它：有值即已读。
    read_time: datetime | None = Field(None, description='阅读时间（为空表示未读）')
    source: str | None = Field(None, description='来源业务对象（如 notice:123；前端认出公告就地打开详情）')
    # 同 `read_time`，查询时由来源方回填（`sources.register_source_attachments`），不是数据库列：
    # 公告发布之后还能再加附件，存进通知里就是一份会过期的快照
    attachment_count: int | None = Field(None, description='来源对象当前的附件个数（没有来源为空）')
    # 同上，查询时由来源方登记的条件现算（`sources.register_explicit_ack`）
    requires_ack: bool = Field(
        False, description='必须读者打开确认（如必须确认的公告）：不能在列表里标已读，「全部已读」也会跳过它'
    )


class GetNotificationUnreadDetail(SchemaBase):
    """未读数（给红点用的轻量接口）"""

    total: int = Field(description='未读总数')
    requires_ack_count: int = Field(
        0, description='未读里必须打开确认的条数（「全部已读」不会标掉它们；total 减去它 = 「全部已读」能标的条数）'
    )
    by_category: dict[str, int] = Field(description='按分类拆开的未读数，key 是分类数值的字符串形式')
