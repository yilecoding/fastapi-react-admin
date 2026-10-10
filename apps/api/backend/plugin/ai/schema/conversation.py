from datetime import datetime

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase, SnowflakeIdIn


class CreateConversationParam(SchemaBase):
    """新建会话参数"""

    title: str = Field('新对话', description='会话标题', max_length=128)
    provider_id: SnowflakeIdIn | None = Field(None, description='指定供应商；不传则用默认供应商')


class UpdateConversationParam(SchemaBase):
    """重命名会话"""

    title: str = Field(description='会话标题', max_length=128)


class GetConversationDetail(SchemaBase):
    """会话详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='会话 ID')
    title: str = Field(description='会话标题')
    provider_id: SnowflakeIdIn | None = Field(None, description='供应商 ID')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')


class GetMessageDetail(SchemaBase):
    """消息详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='消息 ID')
    role: str = Field(description='角色（user/assistant/tool）')
    content: str = Field(description='文本内容')
    tool_calls: str | None = Field(None, description='工具调用 JSON')
    created_time: datetime = Field(description='创建时间')


class ChatParam(SchemaBase):
    """发起一轮对话"""

    conversation_id: SnowflakeIdIn = Field(description='会话 ID')
    content: str = Field(description='用户输入', min_length=1, max_length=8000)


class ConfirmToolParam(SchemaBase):
    """确认执行一个变更类工具"""

    token: str = Field(description='一次性确认令牌', min_length=1)


class GetToolDetail(SchemaBase):
    """工具清单项（给界面展示，也方便排查"为什么 AI 说它没这个能力"）"""

    name: str = Field(description='工具名')
    description: str = Field(description='工具说明')
    domain: str = Field(description='所属域')
    perm: str | None = Field(None, description='要求的权限码')
    mutating: bool = Field(description='是否会改变系统数据')
    parameters: dict = Field(description='入参 JSON Schema')


class GetToolInvocationDetail(SchemaBase):
    """工具调用审计项"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    conversation_id: SnowflakeIdIn = Field(description='会话 ID')
    user_id: SnowflakeIdIn = Field(description='发起人 ID')
    tool_name: str = Field(description='工具名')
    status: int = Field(description='状态（0：成功、1：失败、2：无权限、3：待确认、4：已取消）')
    params_redacted: str | None = Field(None, description='脱敏后的入参')
    result_summary: str | None = Field(None, description='结果摘要')
    permission_code: str | None = Field(None, description='权限码')
    error: str | None = Field(None, description='失败原因')
    duration_ms: int | None = Field(None, description='耗时（毫秒）')
    created_time: datetime = Field(description='调用时间')
