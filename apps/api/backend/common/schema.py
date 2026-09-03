import zoneinfo

from typing import Annotated, Any, ClassVar, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    WithJsonSchema,
    model_validator,
    validate_email,
)

from backend.common.enums import PrimaryKeyType
from backend.core.conf import settings

CustomPhoneNumber = Annotated[str, Field(pattern=r'^1[3-9]\d{9}$')]

# 🔴 **入参侧的雪花 ID：类型仍是 `int`，但 OpenAPI 声明成 `string | integer`。**
#
# 出参侧由 `SchemaBase` 的两个 field_serializer 负责（见文件末尾）；这一条管
# **请求**那一侧，两者是 pydantic 里两份独立的 schema（校验 / 序列化），
# `field_serializer` 只动后者。
#
# 为什么要改声明：前端拿到的所有 ID 都是**字符串**（雪花超出 JS 安全整数，
# 后端 `stringify_unsafe_ints` 统一转的），回传时自然还是字符串。FastAPI 在
# lax 模式下会把 `"123"` 转成 int，所以**一直是能用的** —— 错的只是声明：
# 生成的 `schema.d.ts` 里请求体写着 `number`，于是前端把一个 string 传进去
# 就是编译错误，逼着调用点去 `Number(id)`，而那正是根 CLAUDE.md 硬纪律 6
# 禁的事（`2049629108245233664` → `2049629108245233700`）。
#
# ⚠️ `WithJsonSchema` 是**替换**那个字段的 JSON schema，所以只写 anyOf ——
# `Field(description=...)` 给的描述在字段层，不受影响（实测确认还在）。
# 校验强度不变：`"abc"` 仍然被 `int_parsing` 挡住。
SnowflakeIdIn = Annotated[int, WithJsonSchema({'anyOf': [{'type': 'string'}, {'type': 'integer'}]}, mode='validation')]

# 编码：给代码、配置、外部系统用的**稳定引用键**（部门 / 角色都用它）。
#
# 大写限定是刻意的：编码在界面上和中文名同排显示，混排大小写就看不出哪个是「标识」、
# 哪个是「名字」。首字符限字母是为了留出「纯数字」这个形态 —— 否则 '123' 这种编码
# 在任何一处被 Number() 掉都不会被发现（同硬纪律 6 的雪花 ID 坑）。
CustomCode = Annotated[str, Field(min_length=2, max_length=32, pattern=r'^[A-Z][A-Z0-9_]*$')]


class ColumnLengthChecked:
    """按**绑定模型的列长度**校验字符串字段的 mixin。

    🔴 **不写这层的表现是 500 + 一条裸 SQL 错误。** 实测：给部门的 `leader`
    传 33 个字符（列是 `UniversalStr(32)`），
    `pyodbc.ProgrammingError: String or binary data would be truncated in
    table 'fba_test.dbo.sys_dept', column 'leader'` 直接冒出去。
    前端限了 20 位，后端 schema 一个字都没限。

    🔴 **为什么不逐个字段写 `max_length=32`。** 全仓有 88 个带长度的字符串列，
    Create/Update 系列里缺 `max_length` 的可写字符串字段有 **327 处**（实测数的，
    约 50 个不同字段）。逐个写就是 327 个和列定义分叉的数字 —— 改列忘了改 schema
    的表现又是那条裸 SQL 错误。这里从 `__table__` 现读，**不可能对不上**。

    ⚠️ **为什么不靠全局异常处理器兜。** 那层也加了
    （`exception_handler.py` 的 `dbapi_exception_handler`），但它**盖不住
    INSERT/UPDATE 这条路**：`get_db_transaction` 是在 `begin()` 里 yield 的，
    commit 发生在**依赖收尾**，那时已经出了异常处理器的覆盖范围
    （实测：加了处理器之后冒出来的变成 `ContextDoesNotExistError`，
    因为连 starlette-context 都拆了）。所以写入侧的闸门只能在 schema 这层。

    用法：`class CreateDeptParam(ColumnLengthChecked, DeptSchemaBase): __sa_model__ = Dept`
    """

    #: 绑定的 SQLAlchemy 模型。没绑的子类这层直接放过
    __sa_model__: ClassVar[Any] = None

    @model_validator(mode='after')
    def check_column_lengths(self) -> Self:
        """逐个字符串字段比一遍列长度"""
        model = type(self).__sa_model__
        if model is None:
            return self

        columns = model.__table__.columns
        for name in type(self).model_fields:
            value = getattr(self, name, None)
            if not isinstance(value, str):
                continue
            column = columns.get(name)
            if column is None:
                continue
            length = getattr(column.type, 'length', None)
            if length and len(value) > length:
                raise ValueError(f'{name} 最长 {length} 个字符，收到 {len(value)} 个')
        return self


def _validate_iana_timezone(v: str) -> str:
    """
    校验 IANA 时区标识（`Asia/Shanghai` 这种）。

    **必须校验，不能收裸 str。** 这个值会被前端直接交给
    `Intl.DateTimeFormat(..., { timeZone })`，而那个 API 对不认识的时区是**抛异常**
    （`RangeError: Invalid time zone specified`）—— 存进去一个拼错的名字，
    受害者是那个用户自己：他每次打开任何带时间的页面都白屏，而且改不回来
    （偏好设置页自己也要渲染时间）。写入侧拦住是唯一的时机。
    """
    if v not in zoneinfo.available_timezones():
        raise ValueError(f'无效的时区标识：{v}')
    return v


# 校验放在写入侧。取值范围就是本机 tzdata 的全集，不自己维护白名单 ——
# 前端的选项来自浏览器的 `Intl.supportedValuesOf('timeZone')`，两边都跟着
# 各自的 tzdata 走，不会因为我们漏更新一张表而对不上。
IanaTimeZone = Annotated[str, Field(max_length=64), AfterValidator(_validate_iana_timezone)]


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

        # 🔴 **外键也要，而且必须按可空性分两组写。**
        #
        # 上面那个只覆盖 `id`。外键（`dept_id` / `parent_id` / `role_id`…）指向的
        # 全是雪花主键的表，值一样超出 JS 安全整数 —— `utils/serializers.py` 的
        # `stringify_unsafe_ints` 在**编码层**已经把它们转成字符串了
        # （那份注释里自己写着「外键都漏了」，指的就是这里）。
        #
        # 漏在这里的后果不是数据错，是**声明错**：OpenAPI 把它们写成 `integer`，
        # 于是 `pnpm --filter @admin/api gen:api` 生成的 `schema.d.ts` 里
        # `dept_id` 是 `number | null`，而 wire 上是字符串。前端按类型信它就会去
        # `Number(dept_id)` —— 那正是根 CLAUDE.md 硬纪律 6 禁的事
        # （`2049629108245233664` 会变成 `2049629108245233700`，
        # 连续几个 ID 塌成同一个值）。实测：移动端打开类型推断时第一个撞上的就是这条。
        #
        # ⚠️ **不能直接复用 `serialize_id`** —— 它无条件 `str(value)`，而一半外键
        # 是可空的，`str(None)` 会得到字符串 `'None'`（不报错，前端拿到一个看起来
        # 像值的东西）。
        #
        # 🔴 **也不能一个 serializer 全包。** pydantic 用**返回标注**当那个字段的
        # 序列化 schema，而标注对列出的所有字段是同一份。实测两种写法都会错一半：
        #
        # | 写法 | `type_id: int`（必填） | `dept_id: int \| None` |
        # |---|---|---|
        # | 返回 `str \| int \| None` | ❌ 被放宽成可空 | ✅ |
        # | 返回 `str \| int` + `when_used='unless-none'` | ✅ | ❌ 声明成不可空，而它真的会是 null |
        #
        # 所以按**实际可空性**分两组。加新外键字段时先 grep 一遍它在各 schema 里
        # 是 `int` 还是 `int | None`，放进对应那一组。
        #
        # ⚠️ 只影响**序列化**（响应）。请求体那一侧 pydantic 走的是校验 schema，
        # 仍然声明 `integer` —— 前端回传 ID 时 FastAPI 会把 `"123"` 强转成 int，
        # 所以能用，但**声明上仍然不准**。那要在入参侧另加标注，是另一件事。
        @field_serializer('dept_id', 'parent_id', 'recipient_id', check_fields=False)
        def serialize_nullable_fk(self, value: int | None) -> str | int | None:
            if value is not None and self.model_config.get('from_attributes'):
                return str(value)
            return value

        # `when_used='unless-none'` 是道保险：这几个字段在所有 schema 里都是必填，
        # 真的拿到 None 时原样放过去，而不是变成字符串 `'None'`
        @field_serializer(
            'user_id',
            'role_id',
            'menu_id',
            'type_id',
            'target_id',
            'data_scope_id',
            'data_rule_id',
            check_fields=False,
            when_used='unless-none',
        )
        def serialize_required_fk(self, value: int) -> str | int:
            if self.model_config.get('from_attributes'):
                return str(value)
            return value


def ser_string(value: Any) -> str | None:
    if value:
        return str(value)
    return value
