"""SSE 事件协议——**我们自己的**，不是任何引擎的原生格式。

🔴 **不要改成透传引擎原生事件流。** 直接把 OpenAI 的 chunk 或 pi 的 event 丢给前端，
前端就和那个引擎绑死了：换引擎要求同时改前端，那不叫可插拔，叫可重写。
代价是每个引擎适配器要写一层翻译，收益是前端一行都不用动。
"""

from typing import Any, Literal

from pydantic import Field

from backend.common.schema import SchemaBase


class AgentEventBase(SchemaBase):
    """所有事件的公共形状"""

    type: str = Field(description='事件类型')


class DeltaEvent(AgentEventBase):
    """助手正文的增量文本"""

    type: Literal['delta'] = 'delta'
    text: str = Field(description='新增的文本片段')


class ToolCallEvent(AgentEventBase):
    """模型提议调用某个工具（此时**尚未执行**）"""

    type: Literal['tool_call'] = 'tool_call'
    call_id: str = Field(description='本次调用 ID')
    name: str = Field(description='工具名')
    arguments: dict[str, Any] = Field(default_factory=dict, description='入参（已脱敏）')


class ToolResultEvent(AgentEventBase):
    """工具执行完毕"""

    type: Literal['tool_result'] = 'tool_result'
    call_id: str = Field(description='对应的调用 ID')
    name: str = Field(description='工具名')
    ok: bool = Field(description='是否成功')
    summary: str = Field(description='结果摘要（给人看的，不是给模型看的完整结果）')
    # 下面两个是给界面画「执行轨迹」用的：把一次工具调用显示成可追溯的审计行
    # （工具名 · 权限码 · 耗时）。不发的话前端只能显示一个光秃秃的工具名，
    # 而「这次调用凭什么被允许、花了多久」恰恰是这个产品区别于普通聊天框的地方。
    perm: str | None = Field(None, description='这次调用要求的权限码')
    duration_ms: int | None = Field(None, description='执行耗时（毫秒）')


class ConfirmRequiredEvent(AgentEventBase):
    """变更类工具需要用户二次确认

    前端据此渲染确认卡片；用户点确认后带 `token` 调 `/ai/tools/confirm`。
    """

    type: Literal['confirm_required'] = 'confirm_required'
    token: str = Field(description='一次性确认令牌')
    name: str = Field(description='工具名')
    preview: str = Field(description='变更预览（人类可读）')
    arguments: dict[str, Any] = Field(default_factory=dict, description='将要执行的入参')


class UsageEvent(AgentEventBase):
    """token 用量"""

    type: Literal['usage'] = 'usage'
    prompt_tokens: int = Field(0, description='输入 token')
    completion_tokens: int = Field(0, description='输出 token')


class ErrorEvent(AgentEventBase):
    """出错了。

    🔴 走这个事件而不是靠 HTTP 状态码——SSE 的响应头在第一个字节发出时就定死了，
    流中途失败改不了状态码。前端只认这个帧（硬纪律 9：失败必须是可见状态）。
    """

    type: Literal['error'] = 'error'
    message: str = Field(description='错误信息（已面向用户措辞）')
    code: str | None = Field(None, description='错误代码，便于前端分支处理')


class DoneEvent(AgentEventBase):
    """本轮结束"""

    type: Literal['done'] = 'done'
    message_id: str | None = Field(None, description='落库后的助手消息 ID（雪花，字符串）')


AgentEvent = DeltaEvent | ToolCallEvent | ToolResultEvent | ConfirmRequiredEvent | UsageEvent | ErrorEvent | DoneEvent
