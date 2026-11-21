from backend.common.enums import StrEnum


class UserSocialType(StrEnum):
    """用户社交类型"""

    github = 'Github'
    google = 'Google'


class UserSocialAuthType(StrEnum):
    """用户社交授权类型"""

    login = 'login'
    binding = 'binding'
    # 无密码账号第一次设密码前，用已绑定的第三方账号重新确认身份（#402）
    reauth = 'reauth'
