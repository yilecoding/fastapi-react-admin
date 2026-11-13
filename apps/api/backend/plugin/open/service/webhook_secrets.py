"""轮换期间仍需签名的旧密钥：每把独立到期，兼容升级前的 secret_prev_*。"""

import json

from datetime import datetime

from backend.plugin.open.model import OpenWebhook


def active_previous_secrets(hook: OpenWebhook, now: datetime) -> list[tuple[str, datetime]]:
    """只返回未过期的密文与期限；读取不延长任何密钥的宽限期。"""
    previous = [
        (item['cipher'], datetime.fromisoformat(item['expires_at'])) for item in json.loads(hook.secret_history or '[]')
    ]
    if hook.secret_prev_cipher and hook.secret_prev_expire_time is not None:
        previous.append((hook.secret_prev_cipher, hook.secret_prev_expire_time))
    return [(cipher, expires_at) for cipher, expires_at in previous if expires_at > now]


def encode_previous_secrets(previous: list[tuple[str, datetime]]) -> str | None:
    """历史中只保存已经加密的密钥，不保存明文。"""
    if not previous:
        return None
    return json.dumps([{'cipher': cipher, 'expires_at': expires_at.isoformat()} for cipher, expires_at in previous])
