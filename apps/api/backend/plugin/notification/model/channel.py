"""通知渠道路由的三张表（#166）：系统策略 · 个人偏好 · 投递记录（事务内 outbox）。

- 都不走软删除（`DataClassBase`）：策略 / 偏好是「有行 = 覆盖默认值、没行 = 用注册表的默认值」，
  删一行就是「恢复默认」；投递记录是审计记录，只按保留期清理
- 三张表的字符串列都是 ASCII 码（kind / 渠道 / 状态），但地址和文案要存中文 → 一律 `UniversalStr`
"""

from datetime import datetime

from sqlalchemy import BigInteger, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.model import DataClassBase, TimeZone, UniversalStr, UniversalText, id_key
from backend.utils.timezone import timezone


class NotificationPolicy(DataClassBase):
    """通知渠道系统策略表"""

    __tablename__ = 'sys_notification_policy'
    __table_args__ = (
        UniqueConstraint('kind', 'channel', name='uq_notification_policy'),
        {'comment': '通知渠道系统策略表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    kind: Mapped[str] = mapped_column(UniversalStr(64), comment='通知类型码')
    channel: Mapped[str] = mapped_column(UniversalStr(16), comment='渠道（inapp / email / sms）')
    mode: Mapped[str] = mapped_column(
        UniversalStr(16), comment='策略（off / default_on / default_off / forced）；没有行 = 用注册表的默认值'
    )
    updated_by: Mapped[int | None] = mapped_column(BigInteger, default=None, comment='最后修改人 ID')
    updated_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, onupdate=timezone.now, comment='更新时间'
    )


class NotificationPref(DataClassBase):
    """通知渠道个人偏好表"""

    __tablename__ = 'sys_notification_pref'
    __table_args__ = (
        UniqueConstraint('user_id', 'kind', 'channel', name='uq_notification_pref'),
        {'comment': '通知渠道个人偏好表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='用户 ID')
    kind: Mapped[str] = mapped_column(UniversalStr(64), comment='通知类型码')
    channel: Mapped[str] = mapped_column(UniversalStr(16), comment='渠道')
    enabled: Mapped[bool] = mapped_column(comment='是否接收（只对策略为 default_on / default_off 的格子有意义）')
    updated_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, onupdate=timezone.now, comment='更新时间'
    )


class NotificationDelivery(DataClassBase):
    """通知外部渠道投递记录表"""

    __tablename__ = 'sys_notification_delivery'
    __table_args__ = (
        # worker 每一轮都按「状态 ∈ 待发 ∧ 到点了」取一批：两列一起建索引，不然每 15 秒全表扫一次
        Index('ix_sys_notification_delivery_due', 'status', 'next_attempt_time'),
        {'comment': '通知外部渠道投递记录表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    #: 「你有新的待办」不写站内行，这一列为空
    notification_id: Mapped[int | None] = mapped_column(
        BigInteger, index=True, comment='站内通知 ID（没有站内行时为空）'
    )
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment='接收人 ID')
    kind: Mapped[str] = mapped_column(UniversalStr(64), index=True, comment='通知类型码（冗余，类型删了也读得懂）')
    channel: Mapped[str] = mapped_column(UniversalStr(16), index=True, comment='渠道（email / sms）')
    address: Mapped[str | None] = mapped_column(
        UniversalStr(256), comment='发送时的地址快照（邮箱 / 手机号；列表接口掩码）'
    )
    title: Mapped[str] = mapped_column(UniversalStr(128), comment='标题快照')
    content: Mapped[str] = mapped_column(UniversalText, comment='正文快照')
    link: Mapped[str | None] = mapped_column(UniversalStr(256), comment='前端路由（邮件里拼成绝对地址）')
    status: Mapped[str] = mapped_column(
        UniversalStr(16), comment='状态（pending / sending / sent / failed / exhausted / skipped / unknown）'
    )
    reason: Mapped[str | None] = mapped_column(
        UniversalStr(32), default=None, comment='没发 / 失败的分类（no_address / plugin_missing / permanent …）'
    )
    attempts: Mapped[int] = mapped_column(default=0, comment='已尝试次数')
    next_attempt_time: Mapped[datetime | None] = mapped_column(
        TimeZone, default=None, comment='下一次尝试的时间（不会再试时为空）'
    )
    last_error: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='最近一次的错误原文')
    provider_ref: Mapped[str | None] = mapped_column(
        UniversalStr(128), default=None, comment='渠道侧的流水号（短信日志 ID 等）'
    )
    duration_ms: Mapped[int | None] = mapped_column(default=None, comment='最近一次尝试的耗时（毫秒）')
    sent_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='发送成功的时间')
    # index：列表按它倒序、清理任务按它做范围删除
    created_time: Mapped[datetime] = mapped_column(
        TimeZone, init=False, default_factory=timezone.now, index=True, comment='创建时间'
    )
    updated_time: Mapped[datetime | None] = mapped_column(TimeZone, init=False, default=None, comment='更新时间')
