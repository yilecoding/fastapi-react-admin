import json

from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field, field_validator

from backend.common.schema import SchemaBase


class WebhookSchemaBase(SchemaBase):
    """Webhook 端点基础模型"""

    name: str = Field(min_length=1, max_length=64, description='端点名称')
    url: str = Field(min_length=8, max_length=512, description='接收地址（https）')
    events: list[str] = Field(min_length=1, description='订阅的事件类型；支持 user.* 前缀通配')
    status: int = Field(1, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, max_length=500, description='备注')

    @field_validator('url')
    @classmethod
    def strip_url(cls, v: str) -> str:
        return v.strip()

    @field_validator('events')
    @classmethod
    def strip_events(cls, v: list[str]) -> list[str]:
        items = list(dict.fromkeys(i.strip() for i in v if i.strip()))
        if not items:
            raise ValueError('至少订阅一个事件')
        return items


class CreateWebhookParam(WebhookSchemaBase):
    """新建端点"""

    app_id: int = Field(description='所属应用 ID')


class UpdateWebhookParam(WebhookSchemaBase):
    """更新端点（不含所属应用：建后不可改；不含密钥：换密钥走「重置密钥」）"""


class GetWebhookDetail(WebhookSchemaBase):
    """端点详情 —— 🔴 没有密钥，也没有密文，只有 `secret_hint`"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    app_id: int = Field(description='所属应用 ID')
    secret_hint: str = Field(description='签名密钥前几位（只用于辨认）')
    secret_prev_expire_time: datetime | None = Field(None, description='旧密钥还在一起签名到这个时间（轮换期）')
    disabled_reason: str | None = Field(None, description='停用原因（manual / auto / gone）')
    disabled_time: datetime | None = Field(None, description='停用时间')
    consecutive_failures: int = Field(0, description='连续失败次数')
    first_failure_time: datetime | None = Field(None, description='这一轮连续失败的第一次时间')
    last_delivery_time: datetime | None = Field(None, description='最近一次投递时间')
    last_success_time: datetime | None = Field(None, description='最近一次成功时间')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')

    @field_validator('events', mode='before')
    @classmethod
    def parse_events(cls, v: Any) -> Any:
        return json.loads(v) if isinstance(v, str) else v


class IssuedWebhookSecret(SchemaBase):
    """新建 / 重置密钥之后**唯一一次**返回明文

    🔴 字段名用 `secret_key`：它在 `OPERA_LOG_REDACT_KEYS` 里（同应用的 SK），操作日志落响应体时会打码
    """

    id: int = Field(description='端点 ID')
    secret_key: str = Field(description='明文签名密钥（whsec_ 开头），只显示这一次')


class WebhookEventItem(SchemaBase):
    type: str = Field(description='事件类型')
    label: str = Field(description='说明')
    scope: str = Field(description='应用要授权的 scope')
    sample: dict[str, Any] = Field(description='示例 data')


class WebhookAttemptItem(SchemaBase):
    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    attempt: int = Field(description='第几次尝试')
    url: str = Field(description='发往的地址')
    request_headers: dict[str, str] | None = Field(None, description='请求头（签名已打码）')
    response_code: int | None = Field(None, description='HTTP 状态码')
    response_headers: dict[str, str] | None = Field(None, description='响应头')
    response_body: str | None = Field(None, description='响应体（脱敏 + 截断）')
    error: str | None = Field(None, description='错误')
    duration_ms: int = Field(description='耗时（毫秒）')
    created_time: datetime = Field(description='尝试时间')

    @field_validator('request_headers', 'response_headers', mode='before')
    @classmethod
    def parse_json(cls, v: Any) -> Any:
        return json.loads(v) if isinstance(v, str) else v


class GetWebhookDeliveryRow(SchemaBase):
    id: int = Field(description='记录 ID')
    webhook_id: int = Field(description='端点 ID')
    webhook_name: str = Field(description='端点名称')
    event_id: int = Field(description='事件 ID（= webhook-id）')
    event_type: str = Field(description='事件类型')
    status: str = Field(description='pending / sending / success / failed / exhausted')
    attempts: int = Field(description='已尝试次数')
    next_attempt_time: datetime | None = Field(None, description='下一次尝试的时间')
    last_response_code: int | None = Field(None, description='最近一次的 HTTP 状态码')
    last_error: str | None = Field(None, description='最近一次的错误')
    last_duration_ms: int | None = Field(None, description='最近一次的耗时（毫秒）')
    success_time: datetime | None = Field(None, description='成功的时间')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')


class GetWebhookDeliveryDetail(GetWebhookDeliveryRow):
    payload: str = Field(description='请求体原文')
    attempts_log: list[WebhookAttemptItem] = Field(description='每一次尝试')


class ResendExhaustedParam(SchemaBase):
    since: datetime = Field(description='把这个时间之后产生、已放弃的投递全部改回待发')


class ResendResult(SchemaBase):
    count: int = Field(description='改回待发的条数')


class PingResult(SchemaBase):
    delivery_id: int = Field(description='这次测试的投递记录 ID')
    status: str = Field(description='success / exhausted')
    response_code: int | None = Field(None, description='HTTP 状态码')
    error: str | None = Field(None, description='错误')
    duration_ms: int | None = Field(None, description='耗时（毫秒）')
