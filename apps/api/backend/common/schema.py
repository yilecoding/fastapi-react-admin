from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, EmailStr, Field, validate_email

from backend.common.enums import PrimaryKeyType
from backend.core.conf import settings
from backend.utils.timezone import timezone

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

    model_config = ConfigDict(
        use_enum_values=True,
        json_encoders={
            datetime: lambda x: (
                timezone.to_str(timezone.from_datetime(x))
                if x.tzinfo is not None and x.tzinfo != timezone.tz_info
                else timezone.to_str(x)
            ),
        },
    )

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
