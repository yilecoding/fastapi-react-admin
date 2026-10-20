from datetime import datetime

from sqlalchemy import BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


class AiConversation(Base):
    """AI 会话表"""

    __tablename__ = 'ai_conversation'

    id: Mapped[id_key] = mapped_column(init=False)
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='所属用户 ID')
    title: Mapped[str] = mapped_column(UniversalStr(128), comment='会话标题')
    # 可空：供应商被删掉之后会话要还能看，只是发不出新消息。
    # 做成外键约束会让「删供应商」变成「先迁移所有历史会话」——不值得。
    provider_id: Mapped[int | None] = mapped_column(BigInteger, default=None, comment='使用的供应商 ID')


# 追加写、不改；所以用 `DataClassBase` + 显式 `created_time`，和 `sys_opera_log` 同一类。
# ⚠️ docstring 保持一行 —— 它会被当成表注释写进 DDL。
class AiMessage(DataClassBase):
    """AI 会话消息表"""

    __tablename__ = 'ai_message'

    id: Mapped[id_key] = mapped_column(init=False)
    conversation_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='会话 ID')
    role: Mapped[str] = mapped_column(UniversalStr(16), comment='角色（user/assistant/tool）')
    content: Mapped[str] = mapped_column(UniversalText, comment='文本内容')
    # 助手提议的工具调用（OpenAI tool_calls 原样 JSON）。提议 ≠ 执行——
    # 真正执行与否看 `ai_tool_invocation`，两张表刻意不合并：一个是「模型说了什么」，
    # 一个是「系统做了什么」，把它们混在一行会让审计说不清是谁的责任。
    tool_calls: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='工具调用 JSON')
    tool_call_id: Mapped[str | None] = mapped_column(
        UniversalStr(64), default=None, comment='工具返回对应的调用 ID（role=tool 时有值）'
    )
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, index=True, comment='创建时间'
    )


# 🔴 这是「AI 到底对系统做了什么」的唯一凭据。被拒绝（`DENIED`）的调用**也要落库** ——
# 「有人在反复让 AI 试探他没有权限的操作」只能从这里看出来。
class AiToolInvocation(DataClassBase):
    """AI 工具调用审计表"""

    __tablename__ = 'ai_tool_invocation'

    id: Mapped[id_key] = mapped_column(init=False)
    conversation_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='会话 ID')
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='发起人用户 ID')
    tool_name: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='工具名')
    status: Mapped[int] = mapped_column(comment='状态（0：成功、1：失败、2：无权限、3：待确认、4：已取消）')
    # 已脱敏。原始入参可能夹带手机号/邮箱/密钥（"把张三的手机号改成 xxx"），
    # 原样落库等于让审计表自己变成一个泄露面（同操作日志那条纪律）。
    params_redacted: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='脱敏后的入参 JSON')
    result_summary: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='执行结果摘要')
    permission_code: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='工具声明的权限码')
    error: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='失败原因')
    duration_ms: Mapped[int | None] = mapped_column(default=None, comment='执行耗时（毫秒）')
    # 调用从哪个入口进来。NULL = 网页对话（加这一列之前的存量行也是）；`mcp:<client id>` = 外部系统。
    # 🔴 MCP 的身份是外部系统**声明**的，审计里必须看得出「这次是 X 系统替张三调的」，
    # 否则出了事只能查到张三，查不到是谁替他发起的
    channel: Mapped[str | None] = mapped_column(UniversalStr(64), default=None, comment='调用入口（NULL=网页对话）')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, index=True, comment='创建时间'
    )
