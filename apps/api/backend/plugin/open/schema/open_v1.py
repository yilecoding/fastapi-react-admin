from datetime import datetime
from typing import Generic, TypeVar

from pydantic import Field

from backend.common.schema import SchemaBase

T = TypeVar('T')


class SyncPage(SchemaBase, Generic[T]):
    """增量同步的一页：拿 `next_cursor` 继续翻，直到 `has_more = false`"""

    items: list[T]
    next_cursor: str | None = Field(None, description='下一页的游标（不透明，原样带回）；没有下一页时为空')
    has_more: bool = Field(description='是否还有下一页')


# 🔴 对外 schema 只放**承诺给对方**的字段 —— 内部表加字段不会跟着外泄。
# ID 一律字符串（雪花 ID 超出 JS 安全整数，硬纪律 6），时间一律带时区的 ISO 8601。


class OpenUserOut(SchemaBase):
    id: str = Field(description='用户 ID')
    username: str = Field(description='用户名')
    nickname: str = Field(description='昵称')
    dept_id: str | None = Field(description='部门 ID')
    status: int = Field(description='账号状态（0停用 1正常）')
    deleted: bool = Field(description='是否已删除。对方据此删除本地副本')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(description='最后修改时间（含删除）')


class OpenDeptOut(SchemaBase):
    id: str = Field(description='部门 ID')
    parent_id: str | None = Field(description='上级部门 ID')
    code: str = Field(description='部门编码（跨环境稳定）')
    name: str = Field(description='部门名称')
    sort: int = Field(description='排序')
    leader_id: str | None = Field(description='负责人用户 ID')
    status: int = Field(description='部门状态（0停用 1正常）')
    deleted: bool = Field(description='是否已删除。对方据此删除本地副本')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(description='最后修改时间（含删除）')
