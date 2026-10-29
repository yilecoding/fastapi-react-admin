from enum import StrEnum


class WebhookDeliveryStatus(StrEnum):
    """一条投递（一个事件 × 一个端点）的状态

    ⚠️ 和通知投递不一样，这里**没有「结果未知」**：Webhook 是至少一次投递，对方按 `webhook-id` 去重
    （Standard Webhooks 原文），所以超时 / 停在发送中的行一律按失败重试，不怕重复
    """

    pending = 'pending'
    sending = 'sending'
    success = 'success'
    failed = 'failed'  # 失败，等下一次重试
    exhausted = 'exhausted'  # 不会再自动重试（次数用完 / 410 / 端点停用）


class WebhookDisabledReason(StrEnum):
    """端点被停用的原因"""

    manual = 'manual'
    auto = 'auto'  # 连续失败太久，自动停用
    gone = 'gone'  # 对方回了 410 Gone
