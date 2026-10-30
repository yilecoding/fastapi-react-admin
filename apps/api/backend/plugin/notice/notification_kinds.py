"""通知公告的通知类型（#166）。公告是全员广播：站内一行、不 fan-out，不走邮件 / 短信（那等于全员群发）；
群机器人可以订阅（二期）—— 一个群一条，不按人展开"""

from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.kinds import register_notification_kind

register_notification_kind(
    'announcement',
    label='通知公告',
    category=NotificationCategory.ANNOUNCEMENT,
    defaults={'inapp': 'forced'},
    user_configurable=False,
    broadcast=True,
    bot=True,
)
