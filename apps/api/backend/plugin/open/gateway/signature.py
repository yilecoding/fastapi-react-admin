"""FRA1-HMAC-SHA256：开放接口的请求签名（服务端那一半）。

调用方的参考实现在 `plugin/open/sdk/`，两边对同一组测试向量（`sdk/test_vectors.json`）—— 改这里的任何一步
都会让 `tests/test_open_signature.py` 红，也就是让对接文档里的例子失效。

待签名字符串（`\\n` 连接六段）::

    METHOD
    PATH  # 请求行里的路径，不含查询串，按发送时的原样
    CANONICAL_QUERY  # 参数名排序、同名再按值排序；RFC 3986 编码（空格 = %20，不是 +）
    TIMESTAMP  # X-Timestamp，毫秒
    NONCE  # X-Nonce
    hex(sha256(原始请求体))  # 空 body 取空串的哈希

签名 = hex(HMAC-SHA256(SK, 待签名字符串))

刻意比云厂商简单：不按日期 / 地域 / 服务派生密钥（单服务用不上），也不签 Host
（前面多一层反向代理改了 Host 不至于全挂）。
"""

import hashlib
import hmac

from collections.abc import Iterable
from urllib.parse import quote

ALGORITHM = 'FRA1-HMAC-SHA256'

HEADER_ACCESS_KEY = 'x-access-key'
HEADER_TIMESTAMP = 'x-timestamp'
HEADER_NONCE = 'x-nonce'
HEADER_SIGN = 'x-sign'


def _encode(value: str) -> str:
    # RFC 3986 的非保留字符之外一律百分号编码。`quote` 默认把 `/` 当安全字符，要显式去掉
    return quote(value, safe='-_.~')


def canonical_query(items: Iterable[tuple[str, str]]) -> str:
    """查询参数规范化：先编码，再按（名, 值）排序

    🔴 排序发生在**编码之后**：两边都按编码后的字节序排，才不会因为某一方先排后编、
    遇到 `+` / 中文这类编码后顺序会变的字符时对不上。
    """
    pairs = sorted((_encode(k), _encode(v)) for k, v in items)
    return '&'.join(f'{k}={v}' for k, v in pairs)


def string_to_sign(*, method: str, path: str, query: str, timestamp: str, nonce: str, body: bytes) -> str:
    return '\n'.join([method.upper(), path, query, timestamp, nonce, hashlib.sha256(body).hexdigest()])


def sign(secret: str, text: str) -> str:
    return hmac.new(secret.encode(), text.encode(), hashlib.sha256).hexdigest()


def verify(secret: str, text: str, signature: str) -> bool:
    # 常量时间比较：逐字节比较的响应时间会泄露「前几位对了」
    return hmac.compare_digest(sign(secret, text), signature.lower())
