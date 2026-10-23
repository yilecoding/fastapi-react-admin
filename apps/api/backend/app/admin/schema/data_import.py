from typing import Literal

from pydantic import Field

from backend.common.schema import SchemaBase


class ImportRowError(SchemaBase):
    """一行里的问题"""

    #: Excel 里的**真实行号**（表头是 1）。报给用户的必须是这个，他要拿着它回 Excel 里定位
    row_no: int = Field(description='Excel 行号')
    msg: str = Field(description='问题描述')


class ImportColumnDetail(SchemaBase):
    """预览表格的一列"""

    key: str = Field(description='列 key')
    label: str = Field(description='列名（当前语言）')
    required: bool = Field(description='是否必填')


class ImportPreviewRow(SchemaBase):
    """预览里的一行"""

    row_no: int = Field(description='Excel 行号')
    #: 原样的单元格文本，按列 key 取
    values: dict[str, str | None] = Field(description='单元格原文')
    ok: bool = Field(description='这一行能不能导')
    #: `create` / `update`；有问题的行为空
    action: str | None = Field(None, description='会做什么')
    errors: list[str] = Field(default_factory=list, description='这一行的问题')


class ImportPreviewDetail(SchemaBase):
    """预览结果"""

    #: 换令牌用。提交阶段只带这个，**不回传数据** —— 既不用把解析结果在前端倒一手，
    #: 也堵住「两步之间偷偷改了本地文件」导致预览和提交对不上
    import_token: str = Field(description='导入令牌（一次性）')
    expire_seconds: int = Field(description='令牌有效期（秒）')
    mode: str = Field(description='导入模式（create：只新增、upsert：新增并更新、update：只更新）')
    columns: list[ImportColumnDetail] = Field(description='列')
    total: int = Field(description='解析出的数据行数')
    valid: int = Field(description='其中能导的行数')
    to_create: int = Field(description='会新增的行数')
    to_update: int = Field(description='会更新的行数')
    rows: list[ImportPreviewRow] = Field(description='逐行结果')
    #: 表头里没被认领的列。**必须回报** —— 列名拼错时整份文件照样解析成功，只是那一列的数据全丢了
    ignored_headers: list[str] = Field(default_factory=list, description='未识别的表头')
    empty_rows: int = Field(0, description='被跳过的空行数')
    #: 有问题的行能不能下载成一份「原始行 + 错误原因」的表
    has_report: bool = Field(description='是否有错误报告可下载')


class ImportCommitParam(SchemaBase):
    """提交导入"""

    import_token: str = Field(description='预览接口返回的导入令牌')
    exclude_rows: list[int] = Field(default_factory=list, description='要排除的 Excel 行号')
    #: True = 有一行写不进去就整批不导（全有或全无）；False = 能导的先导，失败的列出来
    atomic: bool = Field(False, description='是否全部成功才提交')


class ImportCommitDetail(SchemaBase):
    """提交结果"""

    #: False 只在 `atomic=True` 且有行失败时出现：这时**一行都没写**
    committed: bool = Field(description='是否已提交')
    created: list[str] = Field(description='新增的（业务键）')
    updated: list[str] = Field(description='更新的（业务键）')
    failed: list[ImportRowError] = Field(description='失败的行')
    notes: list[str] = Field(default_factory=list, description='需要提醒的事')
    has_report: bool = Field(description='是否有错误报告可下载')


ImportModeParam = Literal['create', 'upsert', 'update']
