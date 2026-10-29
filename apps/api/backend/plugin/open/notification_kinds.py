"""能力开放的通知类型（#166 的注册表，#167 用）：Webhook 端点被停用时告诉应用创建人"""

from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.kinds import register_notification_kind

register_notification_kind(
    'open.webhook.disabled',
    label='Webhook 端点已停用',
    category=NotificationCategory.SYSTEM,
    # 对接方的事件从这一刻起全部停投，邮件默认也发：管理员不一定开着后台
    defaults={'inapp': 'forced', 'email': 'default_on'},
)
