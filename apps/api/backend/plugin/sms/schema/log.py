from datetime import datetime

from pydantic import ConfigDict, Field, field_serializer

from backend.common.schema import SchemaBase, SnowflakeIdIn


def mask_phone(phone: str) -> str:
    """`13800000000` → `138****0000`。短于 7 位的全掩"""
    if len(phone) < 7:
        return '*' * len(phone)
    return f'{phone[:3]}{"*" * (len(phone) - 7)}{phone[-4:]}'


class _SmsLogBase(SchemaBase):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='日志 ID（也是传给厂商的流水号）')
    config_id: int | None = Field(None, description='走的哪条配置')
    provider: str = Field(description='厂商码')
    template: str = Field(description='业务模板码（测试短信为 test）')
    template_id: str | None = Field(None, description='厂商模板 ID')
    params: str | None = Field(None, description='厂商侧参数 JSON（敏感参数已打码）')
    status: int = Field(description='0 失败 · 1 已受理 · 2 结果未知 · 3 发送中')
    #: 「发送中」停留太久（进程在两步之间崩溃）：日志页把它显示成「结果未知」
    stale: bool = Field(False, description='status=3 且超过 SMS_SENDING_STALE_SECONDS 仍未更新')
    error_kind: str | None = None
    provider_code: str | None = None
    provider_msg: str | None = None
    request_id: str | None = None
    biz_id: str | None = None
    duration_ms: int | None = None
    created_by: int | None = None
    created_time: datetime
    updated_time: datetime | None = None

    # `config_id` 不在 `SchemaBase` 那两组外键序列化器的名单里，自己转一下（硬纪律 6）
    @field_serializer('config_id', 'created_by')
    def serialize_optional_id(self, value: int | None) -> str | None:
        return None if value is None else str(value)


class GetSmsLogListItem(_SmsLogBase):
    """列表里的一行：**手机号掩码**"""

    phone: str = Field(description='手机号（掩码）')

    @field_serializer('phone')
    def serialize_phone(self, value: str) -> str:
        return mask_phone(value)


class GetSmsLogDetail(_SmsLogBase):
    """详情：完整手机号（要 `sms:log:list`，和列表同一个码 —— 掩码挡的是「扫一眼列表」，不是权限边界）"""

    phone: str = Field(description='手机号（完整）')


class DeleteSmsLogParam(SchemaBase):
    """批量删除"""

    pks: list[SnowflakeIdIn] = Field(min_length=1, description='日志 ID 列表')
