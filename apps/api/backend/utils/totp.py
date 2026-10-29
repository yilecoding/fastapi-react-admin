"""TOTP（RFC 6238）—— 二次验证的动态码。SHA1 / 30 秒 / 6 位，Google Authenticator 等认证器的默认参数。

不引依赖：算法就是 RFC 4226 的 HOTP 套一个时间片，二十行。守卫是 RFC 6238 附录 B 的测试向量（`tests/test_totp.py`）。

🔴 **同一个时间片的码只能用一次**：`verify` 返回命中的时间片，调用方要记下来、下次只认比它大的
（RFC 6238 第 5.2 节：「the verifier MUST NOT accept the second attempt of the OTP after the successful validation」）。
不记的话，被人从肩膀后面看到的那 6 位数在 30～90 秒内都还能再登一次。
"""

import base64
import hashlib
import hmac
import secrets
import struct
import time

from urllib.parse import quote, urlencode

PERIOD = 30
DIGITS = 6
#: 校验时前后各容忍几个时间片（认证器和服务器的时钟偏差）。1 = 前后各 30 秒
WINDOW = 1


def new_secret() -> str:
    """20 字节随机数的 base32（RFC 4226 建议的 160 位），去掉补位的 `=` —— 认证器手动输入时更短"""
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip('=')


def _key(secret: str) -> bytes:
    s = secret.strip().replace(' ', '').upper()
    return base64.b32decode(s + '=' * (-len(s) % 8))


def hotp(key: bytes, counter: int, digits: int = DIGITS, digest: str = 'sha1') -> str:
    mac = hmac.new(key, struct.pack('>Q', counter), digest).digest()
    offset = mac[-1] & 0x0F
    code = struct.unpack('>I', mac[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code % 10**digits).zfill(digits)


def step_of(timestamp: float) -> int:
    return int(timestamp // PERIOD)


def code_at(secret: str, timestamp: float) -> str:
    return hotp(_key(secret), step_of(timestamp))


def verify(secret: str, code: str, *, after_step: int | None = None, now: float | None = None) -> int | None:
    """校验动态码，返回命中的时间片（没命中返回 None）。

    :param after_step: 上一次成功用过的时间片。只认比它大的 —— 同一个码不能用第二次
    """
    code = code.strip().replace(' ', '')
    if len(code) != DIGITS or not code.isdigit():
        return None
    key = _key(secret)
    current = step_of(time.time() if now is None else now)
    for step in range(current - WINDOW, current + WINDOW + 1):
        if after_step is not None and step <= after_step:
            continue
        if hmac.compare_digest(hotp(key, step), code):
            return step
    return None


def provisioning_uri(secret: str, *, account: str, issuer: str) -> str:
    """`otpauth://totp/<issuer>:<account>?secret=…&issuer=…` —— 前端渲染成二维码给认证器扫"""
    label = quote(f'{issuer}:{account}')
    query = urlencode({'secret': secret, 'issuer': issuer, 'algorithm': 'SHA1', 'digits': DIGITS, 'period': PERIOD})
    return f'otpauth://totp/{label}?{query}'


def new_recovery_codes(n: int = 10) -> list[str]:
    """一次性恢复码：`xxxx-xxxx`，去掉了容易看错的 0 / O / 1 / I / L"""
    alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
    return ['-'.join(''.join(secrets.choice(alphabet) for _ in range(4)) for _ in range(2)) for _ in range(n)]


def hash_recovery_code(code: str) -> str:
    """恢复码只存哈希（sha256 足够：它是 40 位随机数，不是人记的口令，不怕字典）。比对前归一大小写和横线"""
    normalized = code.strip().lower().replace(' ', '').replace('-', '')
    return hashlib.sha256(normalized.encode()).hexdigest()
