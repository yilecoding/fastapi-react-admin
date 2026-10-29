"""TOTP 算法对 RFC 6238 附录 B 的测试向量（SHA1 那一列，种子是 ASCII「12345678901234567890」，8 位）"""

import base64

import pytest

from backend.utils import totp

SEED = base64.b32encode(b'12345678901234567890').decode()


@pytest.mark.parametrize(
    ('timestamp', 'expected'),
    [
        (59, '94287082'),
        (1111111109, '07081804'),
        (1111111111, '14050471'),
        (1234567890, '89005924'),
        (2000000000, '69279037'),
        (20000000000, '65353130'),
    ],
)
def test_rfc6238_appendix_b_sha1(timestamp: int, expected: str) -> None:
    assert totp.hotp(base64.b32decode(SEED), totp.step_of(timestamp), digits=8) == expected


def test_verify_accepts_neighbouring_steps_and_reports_which() -> None:
    now = 1_700_000_000
    for offset in (-30, 0, 30):
        code = totp.code_at(SEED, now + offset)
        assert totp.verify(SEED, code, now=now) == totp.step_of(now + offset)
    assert totp.verify(SEED, totp.code_at(SEED, now + 90), now=now) is None, '超出前后各一个时间片就不认'


def test_same_step_cannot_be_used_twice() -> None:
    """RFC 6238 5.2：成功验过的码不能再用 —— 调用方把返回的时间片记下来传回 after_step"""
    now = 1_700_000_000
    code = totp.code_at(SEED, now)
    step = totp.verify(SEED, code, now=now)
    assert step is not None
    assert totp.verify(SEED, code, now=now, after_step=step) is None
    # 下一个时间片的码照常可用
    assert totp.verify(SEED, totp.code_at(SEED, now + 30), now=now + 30, after_step=step) == step + 1


@pytest.mark.parametrize('bad', ['', '12345', '1234567', 'abcdef', '12 34 5x'])
def test_malformed_codes_are_rejected(bad: str) -> None:
    assert totp.verify(SEED, bad, now=1_700_000_000) is None


def test_secret_tolerates_spaces_and_case() -> None:
    """认证器手动输入时人会加空格、写小写"""
    secret = totp.new_secret()
    spaced = ' '.join(secret[i : i + 4] for i in range(0, len(secret), 4)).lower()
    assert totp.code_at(spaced, 1_700_000_000) == totp.code_at(secret, 1_700_000_000)


def test_uri_shape() -> None:
    uri = totp.provisioning_uri('JBSWY3DPEHPK3PXP', account='admin', issuer='中后台')
    assert uri.startswith('otpauth://totp/%E4%B8%AD%E5%90%8E%E5%8F%B0%3Aadmin?secret=JBSWY3DPEHPK3PXP&issuer=')
    assert 'digits=6' in uri and 'period=30' in uri


def test_recovery_codes_hash_ignores_format() -> None:
    codes = totp.new_recovery_codes()
    assert len(set(codes)) == 10 and all(len(c) == 9 and c[4] == '-' for c in codes)
    c = codes[0]
    assert totp.hash_recovery_code(c.upper().replace('-', ' ')) == totp.hash_recovery_code(c)
