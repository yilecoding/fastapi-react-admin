from datetime import datetime
from typing import Any, Literal

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase

#: 「只导选中的行」最多带多少个 ID。再多就该用筛选条件了 —— 一个 IN 列表上千项
#: 在 SQL Server 上逼近参数上限（2100），而且勾选本来就只勾得到当前页
EXPORT_IDS_MAX = 1000


class StartExportParam(SchemaBase):
    """发起一次导出"""

    format: Literal['xlsx', 'csv'] = Field('xlsx', description='文件格式')
    columns: list[str] | None = Field(
        None, max_length=200, description='只导这些列（列 key，按这个顺序）；不给 = 全部列'
    )
    ids: list[int] | None = Field(
        None, min_length=1, max_length=EXPORT_IDS_MAX, description='只导选中的行；不给 = 按筛选条件导'
    )
    filters: dict[str, Any] = Field(default_factory=dict, description='筛选条件，和列表接口的查询参数同名')


class GetExportJobDetail(SchemaBase):
    """一条导出记录"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='导出记录 ID')
    resource: str = Field(description='导出的资源')
    title: str = Field(description='资源名')
    format: str = Field(description='文件格式')
    status: int = Field(description='状态（0：排队、1：生成中、2：完成、3：失败、4：已过期）')
    total: int = Field(description='发起时按条件数出的行数')
    row_count: int | None = Field(None, description='已写出的行数（生成中是进度，完成后是最终行数）')
    file_name: str = Field(description='下载文件名')
    file_size: int | None = Field(None, description='文件字节数')
    file_sha256: str | None = Field(None, description='文件 SHA-256')
    error: str | None = Field(None, description='失败原因')
    download_count: int = Field(description='下载次数')
    created_time: datetime = Field(description='发起时间')
    started_time: datetime | None = Field(None, description='开始生成的时间')
    finished_time: datetime | None = Field(None, description='结束时间')
    expire_time: datetime | None = Field(None, description='文件过期时间')
