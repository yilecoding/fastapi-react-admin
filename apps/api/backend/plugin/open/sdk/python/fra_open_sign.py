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
