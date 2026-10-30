from datetime import datetime

from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import Base, TimeZone, UniversalStr, UniversalText, id_key


class Notice(Base):
    """系统通知公告表"""

    __tablename__ = 'sys_notice'

    id: Mapped[id_key] = mapped_column(init=False)
    title: Mapped[str] = mapped_column(UniversalStr(64), comment='标题')
    type: Mapped[int] = mapped_column(comment='类型（0：通知、1：公告）')
    status: Mapped[int] = mapped_column(comment='状态（0：隐藏、1：显示）')
    content: Mapped[str] = mapped_column(UniversalText, comment='内容')
    # #186：给读者那一侧用的三个字段。「谁能看见」只认 service 里的 `readable_clause()`，
    # 这里不再加别的可见性开关 —— 两处各说各的，附件权限和列表就会对不上
    pinned: Mapped[bool] = mapped_column(default=False, comment='是否置顶')
    level: Mapped[int] = mapped_column(default=0, comment='级别（0：普通、1：重要、2：紧急）')
    expire_time: Mapped[datetime | None] = mapped_column(
        TimeZone, default=None, comment='过期时间（为空不过期；过期后读者看不到，管理页照常可见）'
    )
