"""JWT 编解码：从 python-jose 换到 PyJWT 之后（#193），解码这一侧的拒绝规则不能松

python-jose 被换掉的那条漏洞（CVE-2026-85394）是「不限定算法时能伪造 HS256」。
所以这里守的就是：只认配置里的那一个算法、只认自己的密钥、过期和缺字段都拒。
"""

import base64
import json
import time

import jwt as pyjwt
import pytest

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.security.jwt import jwt_decode, jwt_encode
from backend.core.conf import settings


def _claims(**overrides: object) -> dict:
    return {'session_uuid': 'sid-1', 'sub': '42', 'exp': int(time.time()) + 600, **overrides}


def _b64(part: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(part).encode()).rstrip(b'=').decode()


def _rejected(token: str) -> str:
    with pytest.raises(errors.TokenError) as exc:
        jwt_decode(token)
    return exc.value.detail


def test_round_trip() -> None:
    payload = jwt_decode(jwt_encode(_claims()))
    assert payload.user_id == 42
    assert payload.session_uuid == 'sid-1'


def test_expired_says_expired() -> None:
    assert _rejected(jwt_encode(_claims(exp=int(time.time()) - 10))) == t('error.token.expired')


@pytest.mark.parametrize('missing', ['session_uuid', 'sub', 'exp'])
def test_missing_claim_is_invalid(missing: str) -> None:
    claims = _claims()
    del claims[missing]
    assert _rejected(jwt_encode(claims)) == t('error.token.invalid')


def test_other_secret_is_invalid() -> None:
    token = pyjwt.encode(_claims(), settings.TOKEN_SECRET_KEY + '-not-ours', settings.TOKEN_ALGORITHM)
    assert _rejected(token) == t('error.token.invalid')


@pytest.mark.filterwarnings(
    'ignore:The HMAC key is'
)  # 拿 HS256 的密钥签 HS512，PyJWT 嫌它短 —— 这里本来就是在造坏 token
def test_other_algorithm_with_our_secret_is_invalid() -> None:
    """同一把密钥换个 HMAC 算法签 —— 只认配置里那一个算法，别的一律拒"""
    other = 'HS512' if settings.TOKEN_ALGORITHM != 'HS512' else 'HS256'
    token = pyjwt.encode(_claims(), settings.TOKEN_SECRET_KEY, other)
    assert _rejected(token) == t('error.token.invalid')


def test_alg_none_is_invalid() -> None:
    token = f'{_b64({"alg": "none", "typ": "JWT"})}.{_b64(_claims())}.'
    assert _rejected(token) == t('error.token.invalid')
