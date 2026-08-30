from datetime import datetime

from sqlalchemy import BigInteger, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


class Notification(Base):
    """站内通知表"""

    __tablename__ = 'sys_notification'

    id: Mapped[id_key] = mapped_column(init=False)
    title: Mapped[str] = mapped_column(UniversalStr(128), comment='标题')
    content: Mapped[str] = mapped_column(UniversalText, comment='内容')
    category: Mapped[int] = mapped_column(comment='分类（0：系统、1：公告、2：任务事件）')
    link: Mapped[str | None] = mapped_column(
        UniversalStr(256), default=None, comment='点击跳转的前端路由，为空则不可点'
    )
    # 🔴 NULL = 全员广播，不是「没填」。广播刻意**不** fan-out 成 N 行收件人记录：
    # 一条公告一行，谁读了才在 `sys_notification_read` 里插一行。
    # 代价是未读判定要 NOT EXISTS（见 crud），换来的是加一个用户不用回填历史通知。
    recipient_id: Mapped[int | None] = mapped_column(
        BigInteger, default=None, index=True, comment='接收人 ID（为空表示全员广播）'
    )


class NotificationRead(DataClassBase):
    """站内通知已读标记表

    只有「读过」这一个状态：有行 = 已读，没行 = 未读。不做 `is_read` 布尔列 ——
    那样每新增一个用户都要给全部历史广播补一行。
    """

    __tablename__ = 'sys_notification_read'
    # 两列都非空，直接用普通唯一约束就行。`apps/api/AGENTS.md` 里
    # 「唯一约束含可空列要改用筛选唯一索引」那条说的是含 NULL 的情形，这里不含。
    __table_args__ = (
        UniqueConstraint('notification_id', 'user_id', name='uq_notification_read'),
        {'comment': '站内通知已读标记表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    notification_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='通知 ID')
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='用户 ID')
    read_time: Mapped[datetime] = mapped_column(TimeZone, init=False, default_factory=timezone.now, comment='阅读时间')
