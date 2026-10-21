from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


# 开放接口的调用日志。详细程度和操作日志（`sys_opera_log`）一致，另加应用维度。
#
# 不复用操作日志：`OperaLogMiddleware` 只记 `/api/v1` 开头的请求，`/api/open/v1` 一条都不会进去；
# 而且对接时最要看的「失败原因」（签名不匹配 / AK 无效…）多发生在识别出应用之前，操作日志没地方放。
#
# 应用编码 / 名称存**调用时的快照**：应用改名、删除之后日志仍看得懂。`app_id` 可空 —— AK 无效时识别不出应用。
#
# ⚠️ 类 docstring 保持一行（会原样成为表注释）
class OpenApiLog(DataClassBase):
    """能力开放调用日志表"""

    __tablename__ = 'open_api_log'

    id: Mapped[id_key] = mapped_column(init=False)
    trace_id: Mapped[str] = mapped_column(UniversalStr(32), comment='请求跟踪 ID')
    app_id: Mapped[int | None] = mapped_column(sa.BigInteger, index=True, comment='应用 ID（AK 无效时为空）')
    app_code: Mapped[str | None] = mapped_column(UniversalStr(32), comment='应用编码（调用时的快照）')
    app_name: Mapped[str | None] = mapped_column(UniversalStr(64), comment='应用名称（调用时的快照）')
    access_key: Mapped[str | None] = mapped_column(UniversalStr(64), comment='请求里带来的 Access Key')
    method: Mapped[str] = mapped_column(UniversalStr(16), comment='请求方法')
    title: Mapped[str] = mapped_column(UniversalStr(256), comment='接口摘要')
    path: Mapped[str] = mapped_column(UniversalStr(512), comment='请求路径')
    scope: Mapped[str | None] = mapped_column(UniversalStr(64), comment='本接口需要的 scope')
    scope_granted: Mapped[bool | None] = mapped_column(comment='调用时该应用是否已授权本接口')
    ip: Mapped[str] = mapped_column(UniversalStr(64), comment='来源 IP')
    ip_whitelisted: Mapped[bool | None] = mapped_column(comment='来源 IP 是否在白名单内（白名单为空记为是）')
    country: Mapped[str | None] = mapped_column(UniversalStr(64), comment='国家')
    region: Mapped[str | None] = mapped_column(UniversalStr(64), comment='地区')
    city: Mapped[str | None] = mapped_column(UniversalStr(64), comment='城市')
    user_agent: Mapped[str | None] = mapped_column(UniversalStr(512), comment='用户代理')
    os: Mapped[str | None] = mapped_column(UniversalStr(64), comment='操作系统')
    browser: Mapped[str | None] = mapped_column(UniversalStr(64), comment='浏览器')
    device: Mapped[str | None] = mapped_column(UniversalStr(64), comment='设备')
    args: Mapped[str | None] = mapped_column(sa.JSON(), comment='请求参数')
    request_headers: Mapped[str | None] = mapped_column(sa.JSON(), comment='请求头（已脱敏）')
    response_headers: Mapped[str | None] = mapped_column(sa.JSON(), comment='响应头')
    response_body: Mapped[str | None] = mapped_column(UniversalText, comment='响应体（超限截断）')
    status: Mapped[int] = mapped_column(comment='调用结果（0失败 1成功）')
    code: Mapped[str] = mapped_column(UniversalStr(32), comment='HTTP 状态码')
    error_code: Mapped[str] = mapped_column(
        UniversalStr(64), index=True, comment='ok 或失败原因（open.sign_mismatch…）'
    )
    msg: Mapped[str | None] = mapped_column(UniversalText, comment='提示消息')
    row_count: Mapped[int | None] = mapped_column(comment='返回条数（同步类接口）')
    cost_time: Mapped[float] = mapped_column(comment='请求耗时（ms）')
    # index：列表按它排序筛选、清理任务按它做范围删除（同 sys_opera_log.opera_time）
    request_time: Mapped[datetime] = mapped_column(TimeZone, index=True, comment='调用时间')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, comment='创建时间'
    )
