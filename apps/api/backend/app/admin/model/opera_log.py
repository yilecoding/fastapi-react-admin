from datetime import datetime

import sqlalchemy as sa

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


class OperaLog(DataClassBase):
    """操作日志表"""

    __tablename__ = 'sys_opera_log'

    id: Mapped[id_key] = mapped_column(init=False)
    trace_id: Mapped[str] = mapped_column(UniversalStr(32), comment='请求跟踪 ID')
    username: Mapped[str | None] = mapped_column(UniversalStr(64), comment='用户名')
    method: Mapped[str] = mapped_column(UniversalStr(32), comment='请求方法')
    title: Mapped[str] = mapped_column(UniversalStr(256), comment='操作模块')
    path: Mapped[str] = mapped_column(UniversalStr(512), comment='请求路径')
    ip: Mapped[str] = mapped_column(UniversalStr(64), comment='IP 地址')
    country: Mapped[str | None] = mapped_column(UniversalStr(64), comment='国家')
    region: Mapped[str | None] = mapped_column(UniversalStr(64), comment='地区')
    city: Mapped[str | None] = mapped_column(UniversalStr(64), comment='城市')
    user_agent: Mapped[str | None] = mapped_column(UniversalStr(512), comment='用户代理')
    os: Mapped[str | None] = mapped_column(UniversalStr(64), comment='操作系统')
    browser: Mapped[str | None] = mapped_column(UniversalStr(64), comment='浏览器')
    device: Mapped[str | None] = mapped_column(UniversalStr(64), comment='设备')
    args: Mapped[str | None] = mapped_column(sa.JSON(), comment='请求参数')
    # 以下三项 FBA 原本没有 —— 排查线上问题时只有 args 往往不够，
    # 需要看请求头（鉴权/来源/内容协商）和响应体（后端到底返了什么）
    request_headers: Mapped[str | None] = mapped_column(sa.JSON(), comment='请求头（已脱敏）')
    response_headers: Mapped[str | None] = mapped_column(sa.JSON(), comment='响应头')
    response_body: Mapped[str | None] = mapped_column(UniversalText, comment='响应体（超限截断）')
    status: Mapped[int] = mapped_column(comment='操作状态（0异常 1正常）')
    code: Mapped[str] = mapped_column(UniversalStr(32), insert_default='200', comment='操作状态码')
    msg: Mapped[str | None] = mapped_column(UniversalText, comment='提示消息')
    cost_time: Mapped[float] = mapped_column(insert_default=0.0, comment='请求耗时（ms）')
    opera_time: Mapped[datetime] = mapped_column(TimeZone, comment='操作时间')
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, comment='创建时间'
    )
