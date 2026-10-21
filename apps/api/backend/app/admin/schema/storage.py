from datetime import datetime
from typing import Literal

from pydantic import ConfigDict, Field, field_validator

from backend.app.admin.model import Storage
from backend.common.schema import ColumnLengthChecked, CustomCode, SchemaBase

StorageType = Literal['local', 's3']
StorageAddressing = Literal['auto', 'virtual', 'path']


class StorageSchemaBase(SchemaBase):
    """存储可改字段"""

    name: str = Field(min_length=1, description='存储名称')
    root: str = Field('', description='本地：落盘根目录（绝对路径）；S3：对象键前缀（可空）')
    endpoint: str | None = Field(None, description='S3 端点，如 https://oss-cn-hangzhou.aliyuncs.com')
    bucket: str | None = Field(None, description='S3 桶名')
    region: str | None = Field(None, description='S3 区域，如 cn-hangzhou（不带 oss- 前缀）')
    addressing: StorageAddressing = Field('auto', description='寻址方式（auto / virtual / path）')
    access_key: str | None = Field(None, description='Access Key')
    public_base_url: str | None = Field(None, description='公开件的访问地址前缀（CDN / 公开桶域名），对应 public/ 前缀')
    remark: str | None = Field(None, description='备注')

    @field_validator('root')
    @classmethod
    def strip_root(cls, v: str) -> str:
        return (v or '').strip()

    @field_validator('endpoint', 'bucket', 'region', 'access_key', 'public_base_url')
    @classmethod
    def blank_to_none(cls, v: str | None) -> str | None:
        v = (v or '').strip()
        return v or None

    @field_validator('public_base_url')
    @classmethod
    def check_public_base_url(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not v.startswith(('http://', 'https://')):
            raise ValueError('公开访问地址必须以 http:// 或 https:// 开头')
        return v.rstrip('/')


class CreateStorageParam(ColumnLengthChecked, StorageSchemaBase):
    """创建存储参数"""

    __sa_model__ = Storage

    code: CustomCode = Field(description='存储编码（建后不可改）')
    type: StorageType = Field(description='存储类型（local / s3）')
    # 明文只在这一次请求里出现，落库即加密。字段名必须是 `secret_key` —— 它在
    # `OPERA_LOG_REDACT_KEYS` 里，换个名字操作日志就会把它原样记下来
    secret_key: str | None = Field(None, description='Secret Key（明文，落库即加密）')


class UpdateStorageParam(ColumnLengthChecked, StorageSchemaBase):
    """更新存储参数

    🔴 **没有 `code` 和 `type`**：编码被别处引用、类型一换已有文件的 key 就没有意义了 ——
    不可改靠「契约里没有这个字段」实现，不靠前端禁用输入框（同部门 / 角色编码）
    """

    __sa_model__ = Storage

    # 留空 = 不改（编辑其它字段时前端拿不到原文，同 AI 供应商）
    secret_key: str | None = Field(None, description='Secret Key（留空表示不修改）')


class GetStorageDetail(StorageSchemaBase):
    """存储详情

    🔴 这里没有 `secret_key` 也没有 `secret_cipher`：密文出现在任何响应里，它就和明文一样值钱了
    """

    model_config = ConfigDict(from_attributes=True)

    id: int | str = Field(description='存储 ID；内置本地存储为 builtin')
    code: str = Field(description='存储编码')
    type: str = Field(description='存储类型')
    secret_hint: str | None = Field(None, description='Secret Key 前几位（只用于辨认）')
    is_default: bool = Field(description='是否默认存储')
    status: int = Field(description='状态（0：停用、1：正常）')
    builtin: bool = Field(False, description='是否内置本地存储（不可改、不可删）')
    file_count: int = Field(0, description='存储下的文件数')
    created_time: datetime | None = Field(None, description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')


class UpdateStorageStatusParam(SchemaBase):
    """启停参数"""

    status: Literal[0, 1] = Field(description='状态（0：停用、1：正常）')


class TestStorageResult(SchemaBase):
    """测试连接结果"""

    ok: bool = Field(description='是否连通')
    message: str = Field(description='结果说明')
