from sqlalchemy import BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, UniversalStr, UniversalText, id_key


# 对标 ContiNew Admin 的 `sys_sms_config`（对照表见 issue #153）。照 `ai_provider` 的形状：
# 密钥加密落库（`secret_cipher`）、响应只给掩码（`secret_mask`）、默认项只能有一条。
#
# `options` / `templates` 是 JSON **存成文本**（`UniversalText`，同 `ai_mcp_client.act_as`）：
# 三个方言的原生 JSON 类型各不相同。保存时按厂商的 `Config` / `TemplateMapping` 校验过，
# 读出来只 `json.loads`。
#
# 刻意**没有**「代理」字段（腾讯云异步客户端一设代理就 TypeError，代理走进程环境变量）、
# **没有**「重试」字段（阿里云不支持幂等，超时后重试就是重复发）。
#
# ⚠️ 类 docstring 保持一行：它会被原样当成表注释写进 DDL。
class SmsConfig(Base):
    """短信配置表"""

    __tablename__ = 'sms_config'

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='配置名称（展示用）')
    provider: Mapped[str] = mapped_column(UniversalStr(32), comment='厂商码（SDK 注册表里的 code）')
    sign_name: Mapped[str] = mapped_column(UniversalStr(64), comment='短信签名（须已审核通过）')
    options: Mapped[str] = mapped_column(UniversalText, comment='厂商独有配置，JSON 文本（按厂商 Config 校验）')
    templates: Mapped[str] = mapped_column(
        UniversalText, comment='业务模板码 → 厂商模板映射，JSON 文本（形状由厂商 TemplateMapping 决定）'
    )
    access_key_id: Mapped[str | None] = mapped_column(
        UniversalStr(128), default=None, comment='凭据 key（明文；控制台厂商为空）'
    )
    secret_cipher: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='凭据 secret 密文（AES）')
    secret_mask: Mapped[str | None] = mapped_column(
        UniversalStr(64), default=None, comment='凭据 secret 掩码（展示用）'
    )
    weight: Mapped[int] = mapped_column(default=1, comment='权重（加权随机分流用；0 = 不参与自动选取）')
    daily_max: Mapped[int] = mapped_column(default=0, comment='每个自然日的发送上限（0 = 不限；到了就退出自动选取）')
    timeout: Mapped[int] = mapped_column(default=10, comment='请求超时（秒），显式传给 SDK')
    is_default: Mapped[bool] = mapped_column(default=False, comment='是否默认配置（同一时间只有一条）')
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
    created_by: Mapped[int | None] = mapped_column(BigInteger, default=None, comment='创建者 ID')
