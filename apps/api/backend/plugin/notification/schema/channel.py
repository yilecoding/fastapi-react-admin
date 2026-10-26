"""通知渠道路由的接口契约（#166）"""

from datetime import datetime

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase
from backend.plugin.notification.enums import DeliveryStatus, NotificationChannel, PolicyMode


class PolicyCell(SchemaBase):
    channel: NotificationChannel = Field(description='渠道')
    mode: PolicyMode = Field(description='当前生效的策略')
    default: PolicyMode = Field(description='注册表里的默认策略')
    editable: bool = Field(description='能不能改（站内固定 forced）')


class PolicyRow(SchemaBase):
    kind: str = Field(description='通知类型码')
    label: str = Field(description='通知类型名称')
    category: int = Field(description='所属分类（NotificationCategory）')
    broadcast: bool = Field(description='是否全员广播（广播只走站内）')
    user_configurable: bool = Field(description='用户能不能在个人中心自己设')
    cells: list[PolicyCell] = Field(description='支持的渠道（没出现的渠道 = 这个类型不支持）')


class PolicyItem(SchemaBase):
    kind: str = Field(description='通知类型码', max_length=64)
    channel: NotificationChannel = Field(description='渠道')
    mode: PolicyMode = Field(description='策略')


class UpdatePoliciesParam(SchemaBase):
    items: list[PolicyItem] = Field(min_length=1, max_length=200, description='要改的格子')


class PrefCell(SchemaBase):
    channel: NotificationChannel = Field(description='渠道')
    mode: PolicyMode = Field(description='管理员定的策略')
    configurable: bool = Field(description='自己能不能改（forced / off / 站内不能）')
    enabled: bool = Field(description='现在收不收')


class PrefRow(SchemaBase):
    kind: str = Field(description='通知类型码')
    label: str = Field(description='通知类型名称')
    category: int = Field(description='所属分类')
    cells: list[PrefCell]


class GetMyPrefsDetail(SchemaBase):
    items: list[PrefRow]
    has_email: bool = Field(description='有没有绑定邮箱（没有就收不到邮件通知）')
    has_phone: bool = Field(description='有没有绑定手机号（没有就收不到短信通知）')


class PrefItem(SchemaBase):
    kind: str = Field(description='通知类型码', max_length=64)
    channel: NotificationChannel = Field(description='渠道')
    enabled: bool = Field(description='是否接收')


class UpdatePrefsParam(SchemaBase):
    items: list[PrefItem] = Field(min_length=1, max_length=200, description='要改的格子')


class GetDeliveryDetail(SchemaBase):
    """投递记录。列表接口的 `address` 是掩码，详情接口给完整值"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    notification_id: int | None = None
    user_id: int
    kind: str
    channel: str
    address: str | None = None
    title: str
    content: str
    link: str | None = None
    status: DeliveryStatus
    reason: str | None = None
    attempts: int
    next_attempt_time: datetime | None = None
    last_error: str | None = None
    provider_ref: str | None = None
    duration_ms: int | None = None
    sent_time: datetime | None = None
    created_time: datetime
    updated_time: datetime | None = None
