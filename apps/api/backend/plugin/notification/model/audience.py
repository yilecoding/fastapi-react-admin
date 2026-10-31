from sqlalchemy import BigInteger, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, UniversalStr, id_key


class NotificationAudience(DataClassBase):
    """通知受众表

    「这个来源（`notice:<id>`）发给谁」：部门（含下级）/ 角色 / 用户（#190）。
    🔴 **同一个来源一行都没有 = 全员**。收件箱行的可见性（`crud_notification.visible_to`）和公告本身的
    可见性（`crud_notice.readable_clause`）都读这一张表，不在别处另存一份范围 ——
    两份的话附件权限和列表又会对不上（#186 踩过）。
    硬删：改受众就是删了重写。
    """

    __tablename__ = 'sys_notification_audience'
    # 三列都非空，普通唯一约束就行（含可空列才要筛选唯一索引，见 apps/api 分册）
    __table_args__ = (
        UniqueConstraint('source', 'kind', 'target_id', name='uq_notification_audience'),
        {'comment': '通知受众表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    source: Mapped[str] = mapped_column(
        UniversalStr(64), index=True, comment='来源业务对象（如 notice:123，同 sys_notification.source）'
    )
    kind: Mapped[str] = mapped_column(UniversalStr(16), comment='受众类型（dept：部门含下级、role：角色、user：用户）')
    target_id: Mapped[int] = mapped_column(BigInteger, comment='部门 / 角色 / 用户 ID')
