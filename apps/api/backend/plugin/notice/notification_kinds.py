"""通知公告的通知类型（#166）。公告是全员广播：站内一行、不 fan-out，一期不走外部渠道"""

from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.kinds import register_notification_kind

register_notification_kind(
    'announcement',
    label='通知公告',
    category=NotificationCategory.ANNOUNCEMENT,
    defaults={'inapp': 'forced'},
    user_configurable=False,
    broadcast=True,
)
