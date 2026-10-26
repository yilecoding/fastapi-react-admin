"""审批流的通知类型（#166）。通知插件启动时扫描这个模块（`plugin/notification/extensions.py`）。

- 站内一律 forced；邮件默认开的只有「催办」「超时」这两条要人动手的，其余默认关、用户自己开
- 短信只给催办和超时：国内短信只能发审核过的模板，内容多变的结果通知不适合；而且是真金白银，默认关
- `workflow.task_assigned`（你有新的待办）**不写站内行**：站内靠待办数红点感知（`enums.py` 里 WORKFLOW 的注释），
  在铃铛上再出现一次就重复了。但人不开后台时它是最想要的那一条，所以只声明外部渠道
"""

from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.kinds import register_notification_kind

#: 短信变量有长度限制（阿里云单个变量 ≤ 35 字，腾讯云 ≤ 12 字的也常见），截短而不是让厂商拒发
_SMS_TITLE_MAX = 20


register_notification_kind(
    'workflow.task_assigned',
    label='新的待办',
    category=NotificationCategory.WORKFLOW,
    defaults={'email': 'default_off'},
)
register_notification_kind(
    'workflow.remind',
    label='审批催办',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_on', 'sms': 'default_off'},
    sms_template='workflow_remind',
    sms_params=lambda title, content: {'title': title[:_SMS_TITLE_MAX]},
)
register_notification_kind(
    'workflow.timeout',
    label='审批超时提醒',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_on', 'sms': 'default_off'},
    sms_template='workflow_timeout',
    sms_params=lambda title, content: {'title': title[:_SMS_TITLE_MAX]},
)
register_notification_kind(
    'workflow.result',
    label='审批结果',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_off'},
)
register_notification_kind(
    'workflow.cc',
    label='抄送',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_off'},
)
register_notification_kind(
    'workflow.withdrawn',
    label='审批被撤回',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_off'},
)
