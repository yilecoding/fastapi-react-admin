from datetime import datetime

from sqlalchemy import BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, TimeZone, UniversalStr, UniversalText, id_key


# MCP 网关的外部系统凭据。
#
# 🔴 **明文令牌在这张表里不存在**：只存 sha256（鉴权时拿请求里的令牌算一遍去查），
# 外加前几位 `token_hint` 给人辨认「这是哪一把」。明文只在新建 / 重新生成的那一次响应里出现。
#
# `act_as` / `tools` 是 JSON 数组存成文本：三个方言的原生 JSON 类型各不相同，
# 而这两列只有这里读、条数也就几十，不值得为它引一套方言分支。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释，见 provider.py 的同一条）
class AiMcpClient(Base):
    """MCP 网关外部系统凭据表"""

    __tablename__ = 'ai_mcp_client'

    id: Mapped[id_key] = mapped_column(init=False)
    client_id: Mapped[str] = mapped_column(
        UniversalStr(48), index=True, comment='凭据标识（审计里显示为 mcp:<client_id>）'
    )
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='外部系统名称（展示用）')
    token_sha256: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='令牌的 sha256')
    token_hint: Mapped[str] = mapped_column(UniversalStr(24), comment='令牌前几位（只用于辨认）')
    act_as: Mapped[str] = mapped_column(UniversalText, comment='可代表的用户名 JSON 数组（"*" = 任何普通用户）')
    allow_superuser: Mapped[bool] = mapped_column(default=False, comment='是否允许代表超级管理员')
    # 🔴 默认只读。打开后写操作也**不会**由外部系统直接执行：网关只预演并返回一个确认链接，
    # 必须由被代表的那个人本人登录网页点确认（`mcp_gateway/server.py` 那一段）
    allow_write: Mapped[bool] = mapped_column(default=False, comment='是否允许发起写操作（仍需本人在网页确认）')
    tools: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='工具白名单 JSON 数组（NULL = 不限）'
    )
    rate_per_minute: Mapped[int | None] = mapped_column(default=None, comment='每分钟请求上限（NULL = 用全局默认）')
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    last_used_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='最近一次成功鉴权的时间')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
    created_by: Mapped[int | None] = mapped_column(BigInteger, default=None, comment='创建者 ID')
