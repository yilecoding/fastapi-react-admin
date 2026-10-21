import ipaddress
import json

from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field, field_validator

from backend.common.schema import CustomCode, SchemaBase


def _is_network(entry: str) -> bool:
    try:
        ipaddress.ip_network(entry, strict=False)
    except ValueError:
        return False
    return True


class OpenAppSchemaBase(SchemaBase):
    """能力开放应用基础模型"""

    name: str = Field(min_length=1, max_length=64, description='应用名称')
    scopes: list[str] = Field(min_length=1, description='授权调用的开放接口（scope），至少一个')
    ip_whitelist: list[str] | None = Field(None, description='来源 IP 白名单（IP 或 CIDR）；不填表示不限')
    rate_per_minute: int | None = Field(None, ge=1, le=100000, description='每分钟请求上限；不填用全局默认')
    expire_time: datetime | None = Field(None, description='失效时间；不填表示不过期')
    status: int = Field(1, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, max_length=500, description='备注')

    @field_validator('scopes', 'ip_whitelist')
    @classmethod
    def strip_items(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        items = list(dict.fromkeys(i.strip() for i in v if i.strip()))  # 去空、去重、保序
        return items or None

    @field_validator('ip_whitelist')
    @classmethod
    def check_ips(cls, v: list[str] | None) -> list[str] | None:
        # 写错的条目能存进去的话，表现是对方一律 403「IP 不在白名单」，看起来像网络问题
        bad = [entry for entry in v or [] if not _is_network(entry)]
        if bad:
            raise ValueError(f'不是合法的 IP 或 CIDR：{"、".join(bad)}')
        return v


class CreateOpenAppParam(OpenAppSchemaBase):
    """新建应用"""

    code: CustomCode = Field(description='应用编码（大写字母开头，建后不可改）')

    @field_validator('code', mode='before')
    @classmethod
    def upper_code(cls, v: Any) -> Any:
        return v.strip().upper() if isinstance(v, str) else v


class UpdateOpenAppParam(OpenAppSchemaBase):
    """更新应用（不含编码：建后不可改；不含密钥：换密钥走「重置密钥」）"""


class GetOpenAppDetail(OpenAppSchemaBase):
    """应用详情

    🔴 **没有 SK，也没有密文** —— 只有 `secret_hint` 给人辨认。密文 + 一次代码泄露 = 明文。
    """

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    code: str = Field(description='应用编码')
    access_key: str = Field(description='Access Key（公开标识）')
    secret_hint: str = Field(description='Secret Key 前几位（只用于辨认）')
    state: str = Field('enabled', description='派生状态：enabled / disabled / expired（过期由后端按失效时间算）')
    last_used_time: datetime | None = Field(None, description='最近一次调用的时间')
    created_time: datetime = Field(description='创建时间')

    @field_validator('scopes', 'ip_whitelist', mode='before')
    @classmethod
    def parse_json_list(cls, v: Any) -> Any:
        # 库里是 JSON 文本；分页那条路给的是 dict、详情那条给的是 ORM 实例，两种都会走到这里
        return json.loads(v) if isinstance(v, str) else v


class IssuedOpenSecret(SchemaBase):
    """新建 / 重置密钥之后**唯一一次**返回明文 SK

    🔴 字段名 `secret_key` 在 `OPERA_LOG_REDACT_KEYS` 里：操作日志会把 JSON 响应体落进
    `sys_opera_log.response_body`，不打码就等于把明文 SK 永久写进日志表（有测试守着）。
    """

    id: int = Field(description='记录 ID')
    code: str = Field(description='应用编码')
    access_key: str = Field(description='Access Key')
    secret_key: str = Field(description='明文 Secret Key，只显示这一次')


class OpenScopeItem(SchemaBase):
    scope: str = Field(description='scope')
    label: str = Field(description='说明')
    method: str = Field(description='请求方法')
    path: str = Field(description='接口路径')
