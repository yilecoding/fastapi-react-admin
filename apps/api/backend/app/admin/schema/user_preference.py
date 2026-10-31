import json

from datetime import datetime
from typing import Any

from pydantic import Field, field_validator

from backend.common.schema import SchemaBase

#: 偏好键的格式白名单：小写的「命名空间.名字」，至少一个点、最多四段，总长 ≤ 64（= 列长度）。
#: 不维护「允许哪些键」的清单 —— 以后把主题 / 导览搬上来时只加前端，不用改后端；
#: 防滥用靠下面两道：每个值的大小上限 + 每个人的键数上限（`USER_PREFERENCE_MAX_KEYS`）
PREFERENCE_KEY_PATTERN = r'^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,3}$'

#: 单个值序列化之后的上限（UTF-8 字节）。工作台布局十几张卡片不到 1 KB，16 KB 是给以后的偏好留的余量
PREFERENCE_VALUE_MAX_BYTES = 16 * 1024

#: 一个人最多存几个键。键名是格式白名单而不是清单，不设这一道的话一个登录用户能往表里无限塞行
USER_PREFERENCE_MAX_KEYS = 32


def dump_preference_value(value: Any) -> str:
    """把值序列化成落库的 JSON 文本；不合法 / 超大时抛 ValueError

    🔴 **`allow_nan=False` 不能省。** 请求体是 Python 的 `json.loads` 解析的，它**接受** `NaN` /
    `Infinity` 这种 JSON 规范之外的字面量；`json.dumps` 默认也会原样写回去。实测（关掉这道）：
    `PUT {"value": {"w": NaN}}` 回 200，库里存的是 `{"w":NaN}`（不是合法 JSON），而 PUT 的响应和之后的
    GET 都是 `{"w": null}`（响应编码层把 NaN 换成了 null）—— **写进去的和读回来的不是同一份，没有任何报错**
    """
    if value is None:
        # null 留给 GET 表示「没存过」。想回到默认就不要存，存一个 null 会让两种状态分不开
        raise ValueError('偏好值不能为 null')
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    except ValueError as e:
        raise ValueError(f'偏好值不是合法的 JSON：{e}') from e
    size = len(text.encode('utf-8'))
    if size > PREFERENCE_VALUE_MAX_BYTES:
        raise ValueError(f'偏好值太大：{size} 字节，上限 {PREFERENCE_VALUE_MAX_BYTES}')
    return text


class PutUserPreferenceParam(SchemaBase):
    """写一个偏好：整份覆盖，不做合并"""

    value: Any = Field(description='偏好值，任意 JSON（不能是 null），序列化后不超过 16 KB')

    @field_validator('value')
    @classmethod
    def _check_value(cls, v: Any) -> Any:
        dump_preference_value(v)
        return v


class GetUserPreferenceDetail(SchemaBase):
    """读一个偏好。没存过时 `value` 和 `updated_time` 都是 null —— 200，不是 404

    没存过是常态（每个人第一次打开工作台都是），不是错误：404 会让前端的「读失败要可见」
    （硬纪律 9）和「还没存过、用默认布局」混在同一个分支里
    """

    key: str = Field(description='偏好键')
    value: Any | None = Field(None, description='偏好值；null = 没存过')
    updated_time: datetime | None = Field(None, description='最后保存时间；null = 没存过')
