from backend.common.enums import IntEnum, StrEnum


class NotificationCategory(IntEnum):
    """站内通知分类

    `TASK` 的生产者是后台导出（`app/task/tasks/export/tasks.py`）：生成完 / 失败时给发起人发一条，
    链到个人中心的「导出记录」。调度任务的执行事件仍然走 socket.io 的瞬时 toast，不落库
    （见 `app/task/tasks/base.py: TaskBase`）。
    """

    SYSTEM = 0
    ANNOUNCEMENT = 1
    TASK = 2
    #: 审批流（#107）：抄送、催办、结果通知、撤回告知已审批的人。
    #: 办理人的待办**不发**通知 —— 靠待办数感知，避免同一件事在铃铛上出现两次
    WORKFLOW = 3


class NotificationChannel(StrEnum):
    """通知渠道（#166）。值是契约：策略表 / 偏好表 / 投递表都存它，前端矩阵的列也按它排"""

    #: 站内收件箱。`sys_notification` 的那一行就是它，**不进投递表**
    inapp = 'inapp'
    email = 'email'
    sms = 'sms'


#: 走投递表（outbox）的外部渠道
EXTERNAL_CHANNELS: tuple[NotificationChannel, ...] = (NotificationChannel.email, NotificationChannel.sms)


class PolicyMode(StrEnum):
    """系统策略：某个通知类型 × 某条渠道（#166 第二节）"""

    #: 不走这条渠道
    off = 'off'
    #: 默认走，用户可以在个人中心关
    default_on = 'default_on'
    #: 默认不走，用户可以开
    default_off = 'default_off'
    #: 走，用户关不掉
    forced = 'forced'


class DeliveryStatus(StrEnum):
    """`sys_notification_delivery.status`（#166 第四节）"""

    pending = 'pending'
    sending = 'sending'
    sent = 'sent'
    #: 失败了、还会再试（`next_attempt_time` 有值）
    failed = 'failed'
    #: 重试用完 / 永久失败（收件人不存在、配置错了）
    exhausted = 'exhausted'
    #: 没发：没地址 / 渠道插件没装 / 外部渠道总闸关着
    skipped = 'skipped'
    #: 可能已经发出去了（连上之后出的事）。🔴 **不重试** —— 重试就是重复发
    unknown = 'unknown'
