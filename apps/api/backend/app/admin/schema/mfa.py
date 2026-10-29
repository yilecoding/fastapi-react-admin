from datetime import datetime
from typing import Literal

from pydantic import Field

from backend.common.schema import SchemaBase

# 🔴 字段名刻意起成专用的（`otp` / `totp_secret` / `otpauth_uri` / `recovery_codes` / `mfa_token`）：
# 它们都在 `OPERA_LOG_REDACT_KEYS` 里 —— 操作日志会把请求 / 响应体落库，叫 `code` / `secret` 就脱不掉


class MfaChallenge(SchemaBase):
    """登录第一步过了、还差动态码：不发 access token，发一个 5 分钟的一次性令牌"""

    mfa_required: Literal[True] = Field(True, description='恒为 true：需要第二步')
    mfa_token: str = Field(description='第二步要带回来的令牌（5 分钟，最多试 5 次）')
    mfa_setup: bool = Field(description='true = 被强制开启但还没绑定，先走绑定流程')


class MfaChallengeParam(SchemaBase):
    """登录第二步"""

    mfa_token: str = Field(min_length=16, max_length=128, description='登录第一步给的令牌')
    otp: str = Field(min_length=6, max_length=16, description='认证器上的 6 位动态码，或一个恢复码')


class MfaTokenParam(SchemaBase):
    mfa_token: str = Field(min_length=16, max_length=128, description='登录第一步给的令牌')


class MfaOtpParam(SchemaBase):
    otp: str = Field(
        min_length=6, max_length=16, description='认证器上的 6 位动态码（关闭 / 重新生成恢复码时也可以用恢复码）'
    )


class MfaSetupInfo(SchemaBase):
    """绑定用：认证器扫 `otpauth_uri` 的二维码，或者手动输 `totp_secret`"""

    totp_secret: str = Field(description='TOTP 密钥（base32），只在这次响应里出现')
    otpauth_uri: str = Field(description='otpauth:// 链接，前端渲染成二维码')


class MfaRecoveryCodes(SchemaBase):
    recovery_codes: list[str] = Field(description='一次性恢复码，只显示这一次')


class GetMfaStatus(SchemaBase):
    enabled: bool = Field(description='开了没有')
    enabled_time: datetime | None = Field(None, description='开启时间')
    recovery_remaining: int = Field(0, description='还剩几个没用过的恢复码')
    enforced: bool = Field(description='按策略这个人必须开（开了就不能自己关）')
    available: bool = Field(description='服务端配了 MFA_SECRET_KEY（没配时开不了）')
