from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, validate_email

from backend.common.enums import PrimaryKeyType
from backend.core.conf import settings

CustomPhoneNumber = Annotated[str, Field(pattern=r'^1[3-9]\d{9}$')]

# 编码：给代码、配置、外部系统用的**稳定引用键**（部门 / 角色都用它）。
#
# 大写限定是刻意的：编码在界面上和中文名同排显示，混排大小写就看不出哪个是「标识」、
# 哪个是「名字」。首字符限字母是为了留出「纯数字」这个形态 —— 否则 '123' 这种编码
# 在任何一处被 Number() 掉都不会被发现（同硬纪律 6 的雪花 ID 坑）。
CustomCode = Annotated[str, Field(min_length=2, max_length=32, pattern=r'^[A-Z][A-Z0-9_]*$')]


class CustomEmailStr(EmailStr):
    """自定义邮箱类型"""

    @classmethod
    def _validate(cls, input_value: str, /) -> str | None:
        return None if not input_value else validate_email(input_value)[1]


class SchemaBase(BaseModel):
    """基础模型配置"""

    # 🔴 **不要**再给 datetime 加自定义 `json_encoders`。
    #
    # 这里原来把所有时间格式化成 `'%Y-%m-%d %H:%M:%S'` 下发 —— 那个格式
    # **丢掉了时区**，于是浏览器只能靠猜：ES 规范对无时区标记的串，`T` 分隔的
    # 按浏览器本地时区解释、空格分隔的干脆没定义（Safari 历史上直接
    # Invalid Date）。后果是服务端和用户不在同一个时区时，界面上所有时间
    # 整体偏移几小时，而且不报错。前端为此长出过两处 hack：
    # `log-online/api.ts` 自己写解析器，`profile/recent-logins.tsx` 干脆
    # 放弃解析、原样摊字符串。
    #
    # pydantic v2 的**默认**行为正好是我们要的：aware datetime 序列化成
    # 带偏移的 ISO 8601（`2026-08-22T11:59:47+08:00`），无歧义。
    # 顺带这个 `json_encoders` 本身也是 pydantic v2 已废弃的 API。
    #
    # 以后把存储切成 UTC 时，这里同样**一行都不用改** —— 默认序列化会
    # 自动变成 `2026-08-22T03:59:47Z`，因为格式跟着 tzinfo 走。
    model_config = ConfigDict(use_enum_values=True)

    if PrimaryKeyType.snowflake == settings.DATABASE_PK_MODE:
        from pydantic import field_serializer

        # 详情：https://fastapi-practices.github.io/fastapi_best_architecture_docs/backend/reference/pk.html#%E6%B3%A8%E6%84%8F%E4%BA%8B%E9%A1%B9
        @field_serializer('id', check_fields=False)
        def serialize_id(self, value: int) -> str | int:
            if self.model_config.get('from_attributes'):
                return str(value)
            return value


def ser_string(value: Any) -> str | None:
    if value:
        return str(value)
    return value
