"""数据变更审计（#281）：群机器人。由 `common/data_change/registry.load_data_change_extensions()` 扫描导入。

🔴 Webhook 地址本身就是凭据（钉钉 access_token / 企微 key / 飞书 hook ID），和加签密钥一样只记「改过」。
地址的掩码（`webhook_hint`，主机 + 打了码的令牌，界面上本来就显示着）照记：改了地址看得出指向了哪里（#284 评审）。
最近发送时间 / 最近失败原因每发一次都写，不记。
"""

from backend.common.data_change import register_audited
from backend.plugin.notification.model import NotificationBot

register_audited(
    NotificationBot,
    entity='notification_bot',
    title='群机器人',
    label='name',
    fields={
        'name': '名称',
        'platform': '平台',
        'webhook_hint': '地址',
        'kinds': '订阅的通知',
        'status': '状态',
        'remark': '备注',
    },
    enums={'platform': {'feishu': '飞书', 'dingtalk': '钉钉', 'wecom': '企业微信'}, 'status': {0: '停用', 1: '正常'}},
    secret={'webhook_cipher': 'Webhook 地址', 'secret_cipher': '加签密钥'},
    ignore={'last_sent_time', 'last_error', 'created_by', 'created_time', 'updated_time'},
)
