from sqlalchemy import BigInteger
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, UniversalStr, UniversalText, id_key


# 🔴 **明文密钥在这张表里不存在。** `api_key_cipher` 是 `utils/encrypt.py: AESCipher`
# 的产物，`api_key_mask` 才是给人看的（`sk-abc***xyz`）。响应 schema 里两者都不出现
# 密文——见 `schema/provider.py` 的注释。
#
# ⚠️ 类 docstring 保持**一行**：它会被 SQLAlchemy 原样当成表注释写进 DDL，
# 多段文字会让迁移文件里出现一整块带 \n 的注释（实测过）。细节写在这种 `#` 注释里。
class AiProvider(Base):
    """AI 模型供应商表"""

    __tablename__ = 'ai_provider'

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='供应商名称（展示用）')
    provider_type: Mapped[str] = mapped_column(
        UniversalStr(32), comment='类型（openai/deepseek/qwen/glm/custom），只影响默认值与展示'
    )
    # ⚠️ 必须带 `/v1`：代码在它后面拼 `chat/completions`。少写会 404，而 404 的报错
    # 看起来像「模型不存在」——和真的模型名写错分不出来。参考 sop2ppt 的 LLM_API_URL。
    base_url: Mapped[str] = mapped_column(UniversalStr(256), comment='OpenAI 兼容接口地址，必须带 /v1')
    model: Mapped[str] = mapped_column(UniversalStr(128), comment='默认模型名')
    api_key_cipher: Mapped[str] = mapped_column(UniversalText, comment='API Key 密文（AES）')
    api_key_mask: Mapped[str] = mapped_column(UniversalStr(64), comment='API Key 掩码（展示用）')
    timeout: Mapped[int] = mapped_column(default=120, comment='请求超时（秒）')
    # 🔴 默认 True，但内网自签证书网关必须设 False，否则 certifi 验不过。
    # 这是从 sop2ppt 的 LLM_VERIFY_SSL 带过来的真实约束，不是理论上的开关。
    verify_ssl: Mapped[bool] = mapped_column(default=True, comment='是否校验 TLS 证书（内网自签需关）')
    max_retries: Mapped[int] = mapped_column(default=1, comment='失败重试次数')
    # 🔴 是否走系统代理（HTTP(S)_PROXY）。**不能写死**：同一个内网网关，
    # 在不同位置的可达路径是相反的 —— 实测本机 WSL 里直连 TCP 全被挡、
    # 必须经企业代理才通；而 sop2ppt 那台机器上是代理到不了、必须直连。
    # 配错的表现是纯超时（连不上/等 15 秒），看起来像"网关挂了"。
    use_proxy: Mapped[bool] = mapped_column(default=False, comment='是否走系统代理（内网网关按实际可达路径选）')
    is_default: Mapped[bool] = mapped_column(default=False, comment='是否默认供应商')
    status: Mapped[int] = mapped_column(default=1, comment='状态（0：停用、1：正常）')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')
    created_by: Mapped[int | None] = mapped_column(BigInteger, default=None, comment='创建者 ID')
