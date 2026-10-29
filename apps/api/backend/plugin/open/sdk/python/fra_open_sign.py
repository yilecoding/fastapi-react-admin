"""开放接口签名（FRA1-HMAC-SHA256）—— Python 参考实现，只用标准库，可以整个文件拷走。

用法::

    import requests
    from fra_open_sign import sign_headers

    url = 'https://admin.example.com/api/open/v1/users?limit=500'
    headers = sign_headers('GET', url, b'', access_key='fra_ak_…', secret_key='fra_sk_…')
    resp = requests.get(url, headers=headers)

🔴 请求体要签**实际发出去的那串字节**：先 `json.dumps(...)` 得到字节、签它、再原样发它。
不要签一个 dict 再让 HTTP 库重新序列化 —— 字段顺序或空格一变签名就对不上。
"""

import base64
import hashlib
import hmac
import time
import uuid

from urllib.parse import parse_qsl, quote, urlsplit


def _encode(value: str) -> str:
    return quote(value, safe='-_.~')


def canonical_query(query: str) -> str:
    pairs = sorted((_encode(k), _encode(v)) for k, v in parse_qsl(query, keep_blank_values=True))
    return '&'.join(f'{k}={v}' for k, v in pairs)


def string_to_sign(method: str, url: str, body: bytes, timestamp: str, nonce: str) -> str:
    parts = urlsplit(url)
    return '\n'.join([
        method.upper(),
        parts.path or '/',
        canonical_query(parts.query),
        timestamp,
        nonce,
        hashlib.sha256(body).hexdigest(),
    ])


def sign_headers(
    method: str,
    url: str,
    body: bytes,
    *,
    access_key: str,
    secret_key: str,
    timestamp: str | None = None,
    nonce: str | None = None,
) -> dict[str, str]:
    timestamp = timestamp or str(int(time.time() * 1000))
    nonce = nonce or uuid.uuid4().hex
    text = string_to_sign(method, url, body, timestamp, nonce)
    signature = hmac.new(secret_key.encode(), text.encode(), hashlib.sha256).hexdigest()
    return {
        'X-Access-Key': access_key,
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        'X-Sign': signature,
    }


# ── 接收 Webhook 事件（Standard Webhooks）────────────────────────────────────


def verify_webhook(headers: dict[str, str], body: bytes, secret: str, *, tolerance: int = 300) -> bool:
    """验一条推过来的事件：签名对、时间戳在 ±tolerance 秒内，返回 True。

    🔴 `body` 要传**收到的原始字节**，不要先 `json.loads` 再 `json.dumps` 回去 —— 字节一变签名就对不上。
    密钥轮换的那 24 小时里一条消息带两个签名（空格分隔），任一个对上即可。
    对方会重试（至少一次投递），请按 `webhook-id` 去重。

    用法（Flask）::

        if not verify_webhook(dict(request.headers), request.get_data(), 'whsec_…'):
            abort(401)
    """
    h = {k.lower(): v for k, v in headers.items()}
    msg_id, ts, sigs = h.get('webhook-id'), h.get('webhook-timestamp'), h.get('webhook-signature')
    if not msg_id or not ts or not sigs:
        return False
    try:
        timestamp = int(ts)
    except ValueError:
        return False
    if abs(time.time() - timestamp) > tolerance:
        return False
    key = base64.b64decode(secret.removeprefix('whsec_'))
    expected = base64.b64encode(hmac.new(key, f'{msg_id}.{timestamp}.'.encode() + body, hashlib.sha256).digest())
    for part in sigs.split(' '):
        version, _, value = part.partition(',')
        if version == 'v1' and hmac.compare_digest(value.encode(), expected):
            return True
    return False
