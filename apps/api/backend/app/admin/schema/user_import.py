from pydantic import Field

from backend.common.schema import SchemaBase


class ImportRowError(SchemaBase):
    """一行里某一处的问题"""

    #: Excel 里的**真实行号**（表头是 1）。报给用户的必须是这个，
    #: 不是「第几条数据」—— 他要拿着它回 Excel 里定位
    row_no: int = Field(description='Excel 行号')
    column: str | None = Field(None, description='出问题的列，整行性问题为空')
    msg: str = Field(description='问题描述')


class ImportPreviewRow(SchemaBase):
    """预览里的一行"""

    row_no: int = Field(description='Excel 行号')
    username: str | None = Field(None, description='用户名')
    nickname: str | None = Field(None, description='昵称')
    email: str | None = Field(None, description='邮箱')
    phone: str | None = Field(None, description='手机号')
    dept_code: str | None = Field(None, description='部门编码')
    role_codes: list[str] = Field(default_factory=list, description='角色编码')
    ok: bool = Field(description='这一行能不能建')
    errors: list[str] = Field(default_factory=list, description='这一行的问题')


class ImportPreviewDetail(SchemaBase):
    """预览结果"""

    #: 换 token 用。提交阶段只带这个，**不回传数据** —— 既不用把解析结果在前端
    #: 倒一手，也堵住「两步之间偷偷改了本地文件」导致预览和提交对不上
    import_token: str = Field(description='导入令牌')
    expire_seconds: int = Field(description='令牌有效期（秒）')
    total: int = Field(description='解析出的数据行数')
    valid: int = Field(description='其中可以建的行数')
    rows: list[ImportPreviewRow] = Field(description='逐行结果')
    #: 表头里没被认领的列。**必须回报** —— `phone` 拼成 `phone_number` 时
    #: 整份文件照样解析成功，只是那一列的数据全丢了，纯静默
    ignored_headers: list[str] = Field(default_factory=list, description='未识别的表头')
    empty_rows: int = Field(0, description='被跳过的空行数')


class ImportCommitParam(SchemaBase):
    """提交导入"""

    import_token: str = Field(description='预览接口返回的导入令牌')
    exclude_rows: list[int] = Field(default_factory=list, description='要排除的 Excel 行号')


class ImportCommitDetail(SchemaBase):
    """提交结果"""

    created: list[str] = Field(description='成功创建的用户名')
    failed: list[ImportRowError] = Field(description='失败的行')
    #: 🔴 **只回报「用了默认密码」这个事实，不回报密码本身。**
    #: `opera_log_middleware` 会把 JSON 响应体原样写进 `sys_opera_log.response_body`，
    #: 把明文密码放进来等于永久写进日志表，任何有日志查看权限的人都能翻出来
    used_default_password: bool = Field(description='这批账号是否使用了系统默认密码')
