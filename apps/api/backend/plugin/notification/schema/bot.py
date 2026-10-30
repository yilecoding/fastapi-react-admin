"""群机器人的接口契约（#166 二期）"""

from datetime import datetime

from pydantic import ConfigDict, Field, field_validator

from backend.common.schema import SchemaBase
from backend.plugin.notification.enums import BotPlatform


class BotSchemaBase(SchemaBase):
    name: str = Field(min_length=1, max_length=64, description='名称')
    platform: BotPlatform = Field(description='平台（feishu / dingtalk / wecom）')
    kinds: list[str] = Field(min_length=1, max_length=50, description='订阅的通知类型码')
    status: int = Field(1, ge=0, le=1, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, max_length=256, description='备注')

    @field_validator('name')
    @classmethod
    def strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError('名称不能为空')
        return v

    @field_validator('kinds')
    @classmethod
    def dedupe_kinds(cls, v: list[str]) -> list[str]:
        items = list(dict.fromkeys(i.strip() for i in v if i.strip()))
        if not items:
            raise ValueError('至少订阅一类通知')
        return items


class CreateBotParam(BotSchemaBase):
    """🔴 `webhook_url` / `sign_secret` 都在 `OPERA_LOG_REDACT_KEYS` 里：地址本身就是凭据，不能原样进操作日志"""

    webhook_url: str = Field(min_length=10, max_length=1024, description='Webhook 地址（地址本身就是凭据）')
    sign_secret: str | None = Field(None, max_length=256, description='加签密钥（飞书 / 钉钉开了「签名校验」时填）')


class UpdateBotParam(BotSchemaBase):
    """🔴 `webhook_url` / `sign_secret` 留空 = 不改（详情接口不回明文，表单没法原样带回）。
    `clear_sign_secret` 才是「关掉加签」，否则「留空」和「去掉密钥」分不开"""

    webhook_url: str | None = Field(None, max_length=1024, description='新的 Webhook 地址；留空不改')
    sign_secret: str | None = Field(None, max_length=256, description='新的加签密钥；留空不改')
    clear_sign_secret: bool = Field(False, description='去掉加签密钥（机器人那边关掉了「签名校验」）')


class GetBotDetail(BotSchemaBase):
    """🔴 没有地址明文、没有密钥，只有 `webhook_hint` / `has_secret`"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    webhook_hint: str = Field(description='Webhook 地址掩码（只用于辨认）')
    has_secret: bool = Field(description='有没有配加签密钥')
    last_sent_time: datetime | None = Field(None, description='最近一次发送成功的时间')
    last_error: str | None = Field(None, description='最近一次失败的原因（成功后清空）')
    created_time: datetime
    updated_time: datetime | None = None


class BotKindOption(SchemaBase):
    kind: str = Field(description='通知类型码')
    label: str = Field(description='通知类型名称')
    category: int = Field(description='所属分类')


class BotOptions(SchemaBase):
    """新建 / 编辑表单要的选项：能订阅的通知类型（只有声明了 `bot=True` 的）"""

    kinds: list[BotKindOption]
    #: 没配加密密钥时表单直接告诉人「存不了」，而不是填完点保存才报错
    encrypt_key_ready: bool


class BotTestResult(SchemaBase):
    ok: bool = Field(description='平台收下了没有')
    reason: str | None = Field(None, description='失败分类（sign_failed / keyword_missing / rate_limited …）')
    error: str | None = Field(None, description='对方回的原话 / 网络错误')
    duration_ms: int = Field(0, description='耗时（毫秒）')
