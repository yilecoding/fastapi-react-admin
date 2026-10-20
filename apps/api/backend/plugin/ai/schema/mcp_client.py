import json

from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field, field_validator

from backend.common.schema import SchemaBase

# 和 `mcp_gateway/auth.py: McpClient.id` 同一个格式：它会出现在审计的 `channel` 里（`mcp:<client_id>`），
# 也会被外部系统写进配置文件 —— 只留小写字母、数字、- 和 _
CLIENT_ID_PATTERN = r'^[a-z0-9][a-z0-9_-]*$'


class AiMcpClientSchemaBase(SchemaBase):
    """MCP 凭据基础模型"""

    name: str = Field(min_length=1, max_length=64, description='外部系统名称')
    act_as: list[str] = Field(min_length=1, description='可代表的用户名；"*" 表示任何普通用户')
    allow_superuser: bool = Field(False, description='是否允许代表超级管理员（默认不允许）')
    allow_write: bool = Field(
        False, description='是否允许发起写操作（默认不允许；允许后也只预演，须被代表的人本人在网页确认）'
    )
    tools: list[str] | None = Field(None, description='工具白名单；不填表示不限（只能收窄，不能放大）')
    rate_per_minute: int | None = Field(None, ge=1, le=10000, description='每分钟请求上限；不填用全局默认')
    status: int = Field(1, description='状态（0：停用、1：正常）')
    remark: str | None = Field(None, description='备注')

    @field_validator('act_as', 'tools')
    @classmethod
    def strip_items(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        items = list(dict.fromkeys(i.strip() for i in v if i.strip()))  # 去空、去重、保序
        return items


class CreateAiMcpClientParam(AiMcpClientSchemaBase):
    """新建 MCP 凭据"""

    client_id: str = Field(min_length=1, max_length=48, pattern=CLIENT_ID_PATTERN, description='凭据标识（建后不可改）')


class UpdateAiMcpClientParam(AiMcpClientSchemaBase):
    """更新 MCP 凭据（不含令牌：换令牌走「重新生成」）"""


class GetAiMcpClientDetail(AiMcpClientSchemaBase):
    """MCP 凭据详情

    🔴 **没有令牌，也没有令牌哈希** —— 只有 `token_hint` 给人辨认。
    哈希虽然不能直接用，但出现在响应里就会进操作日志、进浏览器缓存，没有任何理由让它出门。
    """

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    client_id: str = Field(description='凭据标识')
    token_hint: str = Field(description='令牌前几位（只用于辨认）')
    last_used_time: datetime | None = Field(None, description='最近一次成功鉴权的时间')
    created_time: datetime = Field(description='创建时间')

    @field_validator('act_as', 'tools', mode='before')
    @classmethod
    def parse_json_list(cls, v: Any) -> Any:
        # 库里是 JSON 文本；分页那条路给的是 dict、详情那条给的是 ORM 实例，两种都会走到这里
        return json.loads(v) if isinstance(v, str) else v


class IssuedAiMcpToken(SchemaBase):
    """新建 / 重新生成之后**唯一一次**返回明文令牌

    🔴 字段名 `mcp_token` 在 `OPERA_LOG_REDACT_KEYS` 里：操作日志会把 JSON 响应体落进
    `sys_opera_log.response_body`，不打码就等于把明文令牌永久写进日志表（`test_ai_mcp_clients.py` 守着）。
    """

    id: int = Field(description='记录 ID')
    client_id: str = Field(description='凭据标识')
    mcp_token: str = Field(description='明文令牌，只显示这一次')
