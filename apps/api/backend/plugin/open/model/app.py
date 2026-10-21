from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, TimeZone, UniversalStr, UniversalText, id_key


# 一个「应用」= 一个对接的外部系统：一对 AK/SK + 它能调哪些开放接口。
#
# 🔴 **SK 是加密存的，不是哈希**：验签要拿 SK 重算一遍 HMAC，所以必须能还原
# （同 AI 供应商密钥，`utils/encrypt.py: AESCipher`，密钥取 `OPEN_SECRET_KEY`）。
# 详情 / 列表里**连密文都不出**，只有 `secret_hint` 给人辨认 —— 密文 + 一次代码泄露 = 明文。
#
# `scopes` / `ip_whitelist` 是 JSON 数组存成文本，同 `ai_mcp_client.act_as`：
# 三个方言的原生 JSON 类型各不相同，而这两列只有这里读。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class OpenApp(Base):
    """能力开放应用表"""

    __tablename__ = 'open_app'
    # 🔴 写了 `__table_args__` 就要显式带 comment：docstring 自动成为表注释那一步会被这里覆盖掉（同 sys_user）
    __table_args__ = (
        sa.UniqueConstraint('code', 'deleted', name='uk_open_app_code_deleted'),
        {'comment': '能力开放应用表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='应用名称')
    code: Mapped[str] = mapped_column(UniversalStr(32), index=True, comment='应用编码（调用日志里显示为 app:<code>）')
    access_key: Mapped[str] = mapped_column(UniversalStr(64), unique=True, comment='Access Key（公开标识，明文）')
    secret_cipher: Mapped[str] = mapped_column(UniversalText, comment='Secret Key 密文（AES）')
    secret_hint: Mapped[str] = mapped_column(UniversalStr(24), comment='Secret Key 前几位（只用于辨认）')
    scopes: Mapped[str] = mapped_column(UniversalText, comment='授权调用的开放接口 JSON 数组')
    ip_whitelist: Mapped[str | None] = mapped_column(
        UniversalText, default=None, comment='来源 IP 白名单 JSON 数组（NULL = 不限）'
    )
    rate_per_minute: Mapped[int | None] = mapped_column(default=None, comment='每分钟请求上限（NULL = 用全局默认）')
    expire_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='失效时间（NULL = 不过期）')
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    last_used_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='最近一次调用的时间')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
    created_by: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='创建者 ID')
