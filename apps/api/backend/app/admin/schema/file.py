from datetime import datetime
from urllib.parse import quote

from pydantic import ConfigDict, Field, computed_field

from backend.common.enums import FileType
from backend.common.schema import SchemaBase, SnowflakeIdIn
from backend.core.conf import settings


class GetFileDetail(SchemaBase):
    """文件详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='文件 ID')
    name: str = Field(description='存储文件名')
    # 相对落盘根目录的路径（含 YYYY/MM/DD 日期目录）
    path: str = Field(description='相对存储路径')
    is_public: bool = Field(False, description='是否落在公开子树（不鉴权可读）')
    original_name: str = Field(description='原始文件名')
    ext: str = Field(description='扩展名')
    content_type: str | None = Field(None, description='MIME 类型')
    size: int = Field(description='字节数')
    sha256: str | None = Field(None, description='文件内容 SHA-256')
    type: FileType = Field(description='文件分类')
    # 声明成 `int | str` 而不是 `int`：编码层的 `stringify_unsafe_ints` 会把超过
    # 2^53 的整数下发成字符串，而 `SchemaBase` 的 field_serializer 只认字段名 `id`。
    # 写 `int` 会让 openapi 生成 `number`，前端 tsc 以为能当数字用 —— 类型和运行时对不上。
    # （同样的账 `dept_id` / `parent_id` 也欠着，那是既有问题，不在本次范围）
    created_by: int | str = Field(description='上传人 ID')
    created_time: datetime = Field(description='上传时间')
    updated_time: datetime | None = Field(None, description='更新时间')

    @computed_field(description='带鉴权的下载/预览地址')
    @property
    def download_url(self) -> str:
        """
        带鉴权的读取地址。

        做成**计算字段挂在详情上**，而不是单独搞一个「上传结果」子类：
        原来 `download_url` 只在上传/详情的响应里有，列表接口返回的是不带它的
        `GetFileDetail` —— 于是前端预览拼出 `http://127.0.0.1:8000undefined`，
        弹窗里是「文件加载失败」（实测踩到）。每个读取路径都要这个地址，
        那它就该长在唯一的详情模型上。

        刻意**不返回** `/static/upload/<name>`：那个无鉴权静态挂载已经撤掉了
        （见 core/registrar.py 与 core/path_conf.py）。
        """
        return f'{settings.FASTAPI_API_V1_PATH}/sys/files/{self.id}/download'

    @computed_field(description='无鉴权的直链地址，仅公开子树的文件有')
    @property
    def public_url(self) -> str | None:
        """
        无鉴权直链，供富文本正文里的 `<img src>` 直接加载。

        私有文件返回 `None` 而不是回落到 `download_url` —— 回落会让调用方
        以为「拿到地址就能塞进 `<img src>`」，而那个地址要 Authorization 头，
        表现是图片裂掉、控制台一片 401（`FileThumb` 就是为了绕这一点才存在）。
        `None` 是明确的「这个文件没有直链」，调用方必须自己决定怎么办。

        **必须 percent-encode**：`build_filename` 的 `_UNSAFE_CHARS` 刻意保留了
        CJK（`\u4e00-\u9fff`），所以落盘名可以是 `季度报告_a1b2….png`。
        裸拼进 URL 在多数浏览器里能用，但 `Content-Disposition`、
        代理日志、以及 `new URL()` 的行为都不一致。`safe='/'` 是必须的 ——
        不留斜杠会把日期目录的分隔符也编码成 `%2F`，静态挂载直接 404。
        """
        if not self.is_public or not self.path:
            return None
        return f'/uploads/{quote(self.path, safe="/")}'


class DeleteFileParam(SchemaBase):
    """删除文件参数"""

    pks: list[int] = Field(description='文件 ID 列表')


class GetFileStatisticsDetail(SchemaBase):
    """文件资源统计"""

    total_count: int = Field(description='文件总数')
    total_size: int = Field(description='占用总字节数')
    type_counts: dict[str, int] = Field(description='各分类的文件数')
    type_sizes: dict[str, int] = Field(description='各分类的占用字节数')


class CreateFileRelationParam(SchemaBase):
    """挂载附件参数"""

    file_ids: list[int] = Field(description='文件 ID 列表')
    target_type: str = Field(max_length=32, description='业务对象类型')
    target_id: SnowflakeIdIn = Field(description='业务对象 ID')


class DeleteFileRelationParam(SchemaBase):
    """卸载附件参数"""

    file_ids: list[int] = Field(description='文件 ID 列表')
    target_type: str = Field(max_length=32, description='业务对象类型')
    target_id: SnowflakeIdIn = Field(description='业务对象 ID')
