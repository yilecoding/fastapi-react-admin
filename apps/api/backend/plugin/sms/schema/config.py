import json

from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field, field_validator

from backend.common.schema import ColumnLengthChecked, CustomPhoneNumber, SchemaBase
from backend.plugin.sms.model import SmsConfig
from backend.plugin.sms.model.log import TEMPLATE_ID_MAX_LEN


class SmsConfigSchemaBase(SchemaBase):
    """短信配置基础模型"""

    name: str = Field(min_length=1, description='配置名称')
    provider: str = Field(min_length=1, description='厂商码（GET /sms/configs/providers 里的 code）')
    sign_name: str = Field(min_length=1, description='短信签名（须已审核通过；腾讯云填签名内容不是签名 ID）')
    access_key_id: str | None = Field(None, description='凭据 key（AccessKey ID / SecretId）；控制台厂商不填')
    options: dict[str, Any] = Field(default_factory=dict, description='厂商独有配置，按厂商 Config 校验')
    templates: dict[str, Any] = Field(
        default_factory=dict,
        description='业务模板码 → 厂商模板，形如 {"captcha": {"template_id": "SMS_xxx", "mapping": {...} | [...]}}',
    )
    weight: int = Field(1, ge=0, le=100, description='权重；0 = 不参与自动选取，只能被指定使用')
    daily_max: int = Field(0, ge=0, description='每个自然日的发送上限；0 = 不限')
    timeout: int = Field(10, ge=1, le=60, description='请求超时（秒）')
    is_default: bool = Field(False, description='是否默认配置')
    status: int = Field(1, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, description='备注')

    @field_validator('name', 'provider', 'sign_name')
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()

    @field_validator('access_key_id')
    @classmethod
    def blank_to_none(cls, v: str | None) -> str | None:
        v = (v or '').strip()
        return v or None


class CreateSmsConfigParam(ColumnLengthChecked, SmsConfigSchemaBase):
    """创建短信配置参数"""

    __sa_model__ = SmsConfig

    # 🔴 字段名必须是 `access_key_secret` —— 它在 `OPERA_LOG_REDACT_KEYS` 里（按键名精确匹配），
    # 换个名字操作日志就会把密钥原样记下来
    access_key_secret: str | None = Field(None, description='凭据 secret（明文，只在这一次请求里出现，落库即加密）')


class UpdateSmsConfigParam(ColumnLengthChecked, SmsConfigSchemaBase):
    """更新短信配置参数"""

    __sa_model__ = SmsConfig

    # 留空 = 不改密钥（编辑其它字段时前端拿不到原文，同 AI 供应商）
    access_key_secret: str | None = Field(None, description='凭据 secret（留空表示不修改）')


class GetSmsConfigDetail(SmsConfigSchemaBase):
    """短信配置详情

    🔴 **这里没有 `access_key_secret` 也没有 `secret_cipher`，是刻意的。** 密文一旦出现在任何响应里，
    它就和明文一样值钱了。前端只展示掩码（`TestSecretsNeverLeak` 同款守卫）。
    """

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='配置 ID')
    secret_mask: str | None = Field(None, description='凭据 secret 掩码（仅展示）')
    today_sent: int = Field(0, description='今天已通过这条配置发了多少条（Redis 计数）')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')

    @field_validator('options', 'templates', mode='before')
    @classmethod
    def parse_json(cls, v: Any) -> Any:
        # 库里是 JSON 文本；分页那条路给的是 dict、详情那条给的是 ORM 实例，两种都会走到这里
        return json.loads(v) if isinstance(v, str) else v


class SmsProviderCredentialDescriptor(SchemaBase):
    """厂商的凭据字段怎么叫（给配置页的两个输入框起标题）"""

    key_field: str
    key_label: str
    secret_field: str
    secret_label: str


class SmsProviderDescriptor(SchemaBase):
    """SDK 注册表里的一家厂商（配置页按它渲染表单）"""

    code: str = Field(description='厂商码')
    label: str = Field(description='厂商名')
    template_mapping: str = Field(description='模板参数映射形状：named（按变量名）/ ordered（按位置）')
    template_id_hint: str = Field('', description='「厂商模板 ID」输入框的提示')
    credential: SmsProviderCredentialDescriptor | None = Field(None, description='凭据字段；None = 这家不要凭据')
    options_schema: dict[str, Any] = Field(description='厂商独有配置的 JSON Schema（不含凭据字段）')


class SmsTemplateDescriptor(SchemaBase):
    """注册过的一个业务模板"""

    code: str
    label: str
    params: list[str]
    sensitive: list[str]
    cooldown_seconds: int
    daily_max_per_phone: int


class TestSmsParam(SchemaBase):
    """发测试短信：绕过业务模板，直接给厂商模板 ID 和厂商侧参数，真发一条"""

    phone: CustomPhoneNumber = Field(description='收件手机号（大陆 11 位）')
    template_id: str = Field(min_length=1, max_length=TEMPLATE_ID_MAX_LEN, description='厂商模板 ID')
    params: dict[str, str] | list[str] = Field(
        default_factory=dict, description='厂商侧参数：按变量名的厂商给 {"code": "1234"}，按位置的给 ["1234", "5"]'
    )


class SmsSendResultSchema(SchemaBase):
    """一次发送的结果（测试短信接口返回；`sms_service.send()` 成功时也返回它）"""

    status: str = Field(description='accepted / failed / unknown')
    error_kind: str | None = Field(None, description='SmsErrorKind')
    provider_code: str | None = None
    provider_msg: str | None = None
    request_id: str | None = None
    biz_id: str | None = None
    duration_ms: int = 0
    log_id: str | None = Field(None, description='sms_log 的 id（也是传给厂商的流水号）')
