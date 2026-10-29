"""出站签名：Standard Webhooks（`spec/standard-webhooks.md`）。

```
webhook-id: <事件 id>            重试不变，对方拿它去重
webhook-timestamp: <秒>          每次尝试的时间
webhook-signature: v1,<base64> [v1,<base64>]   空格分隔；密钥轮换期两把各签一个
签名 = base64(HMAC-SHA256(key, f"{id}.{timestamp}.{body}"))，key = 去掉 whsec_ 前缀后 base64 解码的字节
```

为什么不复用入站的 FRA1-HMAC-SHA256：那套签 method / path / query / nonce，是「调用方证明自己」；出站是
「我们证明这条消息是我们发的」，方向相反。Standard Webhooks 有 9 种语言的接收库，对方不用照我们的文档手写验签。

🔴 签的是 **bytes**：body 先序列化成 bytes、签 bytes、发 bytes。三份 SDK 和 `sdk/test_vectors.json` 对着这一份。
"""

import base64
import hashlib
import hmac
import secrets

SECRET_PREFIX = 'whsec_'
HEADER_ID = 'webhook-id'
HEADER_TIMESTAMP = 'webhook-timestamp'
HEADER_SIGNATURE = 'webhook-signature'


def new_secret() -> str:
    """`whsec_` + 24 字节随机数的 base64（规范原文：24–64 字节）"""
    return SECRET_PREFIX + base64.b64encode(secrets.token_bytes(24)).decode()


def _key(secret: str) -> bytes:
    return base64.b64decode(secret.removeprefix(SECRET_PREFIX))


def sign(secret: str, msg_id: str, timestamp: int, body: bytes) -> str:
    """→ `v1,<base64>`"""
    mac = hmac.new(_key(secret), f'{msg_id}.{timestamp}.'.encode() + body, hashlib.sha256).digest()
    return 'v1,' + base64.b64encode(mac).decode()


def signature_header(secrets_: list[str], msg_id: str, timestamp: int, body: bytes) -> str:
    return ' '.join(sign(s, msg_id, timestamp, body) for s in secrets_)


def verify(secret: str, msg_id: str, timestamp: int, signature_header_value: str, body: bytes) -> bool:
    """接收方那一半（测试和 SDK 对拍用）。只认 `v1`，任一个签名对上即可。时间窗口由调用方判"""
    expected = sign(secret, msg_id, timestamp, body).split(',', 1)[1]
    for part in signature_header_value.split(' '):
        version, _, value = part.partition(',')
        if version == 'v1' and hmac.compare_digest(value, expected):
            return True
    return False
