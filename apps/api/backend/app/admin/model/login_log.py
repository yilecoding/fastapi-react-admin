from datetime import datetime

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


class LoginLog(DataClassBase):
    """登录日志表"""

    __tablename__ = 'sys_login_log'

    id: Mapped[id_key] = mapped_column(init=False)
    user_uuid: Mapped[str] = mapped_column(UniversalStr(64), comment='用户UUID')
    username: Mapped[str] = mapped_column(UniversalStr(64), comment='用户名')
    status: Mapped[int] = mapped_column(insert_default=0, comment='登录状态(0失败 1成功)')
    ip: Mapped[str] = mapped_column(UniversalStr(64), comment='登录IP地址')
    country: Mapped[str | None] = mapped_column(UniversalStr(64), comment='国家')
    region: Mapped[str | None] = mapped_column(UniversalStr(64), comment='地区')
    city: Mapped[str | None] = mapped_column(UniversalStr(64), comment='城市')
    user_agent: Mapped[str | None] = mapped_column(UniversalStr(512), comment='请求头')
    os: Mapped[str | None] = mapped_column(UniversalStr(64), comment='操作系统')
    browser: Mapped[str | None] = mapped_column(UniversalStr(64), comment='浏览器')
    device: Mapped[str | None] = mapped_column(UniversalStr(64), comment='设备')
    msg: Mapped[str] = mapped_column(UniversalText, comment='提示消息')
    # index：清理任务按它做范围删除（`app/task/tasks/maintenance`），
    # 而日志表是全库长得最快的表 —— 没索引就是全表扫 + 锁升级 + 阻塞所有写日志的请求
    login_time: Mapped[datetime] = mapped_column(TimeZone, index=True, comment='登录时间')
    # #273：除了登录尝试，账号被锁 / IP 被锁 / 被强制下线也记在这张表里（`LoginLogEvent`）。
    # 🔴 数登录次数、登录失败的地方（工作台）要只数 `login`，不然一次踢人就是一次「登录失败」
    event: Mapped[str] = mapped_column(
        UniversalStr(16),
        default='login',
        comment='事件（login 登录 / locked 账号被锁 / ip_locked IP 被锁 / kicked 被强制下线）',
    )
    created_time: Mapped[datetime] = mapped_column(
        TimeZone,
        init=False,
        default_factory=timezone.now,
        comment='创建时间',
    )
