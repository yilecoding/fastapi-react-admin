from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, DateTimeMixin, TimeZone, UniversalText, id_key


# 二次验证（#181）：一个用户一行，有这一行 = 开启了。
#
# 🔴 **TOTP 密钥加密存、不是哈希**：每次校验都要拿它重算动态码（同 SK，密钥 `MFA_SECRET_KEY`）。
# 恢复码只存 sha256（它是一次性的 40 位随机数，不需要还原）—— JSON 数组 `[{"h": 哈希, "used": 时间或 null}]`，
# 同 open_app.scopes：三个方言的原生 JSON 类型各不相同，而这一列只有这里读。
#
# `last_step` 是最近一次成功用过的 TOTP 时间片：同一个时间片的码不能用第二次（RFC 6238 5.2）。
#
# 硬删：关掉二次验证就是删这一行，没有「还原」的需要
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class UserMfa(DataClassBase, DateTimeMixin):
    """用户二次验证表"""

    __tablename__ = 'sys_user_mfa'

    id: Mapped[id_key] = mapped_column(init=False)
    user_id: Mapped[int] = mapped_column(sa.BigInteger, unique=True, comment='用户 ID')
    secret_cipher: Mapped[str] = mapped_column(UniversalText, comment='TOTP 密钥密文（AES）')
    recovery_hashes: Mapped[str] = mapped_column(UniversalText, comment='恢复码哈希 JSON 数组（用过的记了时间）')
    last_step: Mapped[int | None] = mapped_column(sa.BigInteger, default=None, comment='最近一次成功用过的 TOTP 时间片')
    enabled_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='开启时间')
