"""二次验证（MFA，#181）：TOTP 动态码 + 一次性恢复码。

```
登录（密码 / 手机验证码 / 第三方）── 身份确认 ── gate()
    ├─ 不需要 ──→ 开会话（调用方照旧）
    └─ 需要 ──→ MfaChallenge（Redis 令牌，5 分钟，最多试 5 次）
                 ├─ 已绑定：verify_challenge(otp)
                 └─ 被强制没绑：challenge_setup → challenge_enroll(otp)
```

🔴 **动态码错算进这个账号的登录失败计数**（和密码错同一个锁定策略），而且「密码对了」**不再清零它** —— 清零挪到了
第二步通过之后（`auth_service.mark_login_success`）。原来密码一对就清零的话，有密码的人每登一次能试 5 次、登完又清零，
等于可以无限试 6 位数。
"""

from __future__ import annotations

import json
import secrets

from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select

from backend.app.admin.model import User, UserMfa
from backend.app.admin.schema.mfa import GetMfaStatus, MfaChallenge, MfaRecoveryCodes, MfaSetupInfo
from backend.app.admin.service.user_password_history_service import password_security_service
from backend.common.data_change import data_change_source
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils import totp
from backend.utils.encrypt import AESCipher
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


def _cipher() -> AESCipher:
    """🔴 没配密钥就拒绝，不静默存明文（同 SK / Webhook 密钥）"""
    if not settings.MFA_SECRET_KEY:
        raise errors.ServerError(msg=t('error.mfa.secret_key_missing'))
    try:
        return AESCipher(settings.MFA_SECRET_KEY)
    except ValueError as e:
        raise errors.ServerError(msg=t('error.mfa.secret_key_invalid')) from e


def _issuer() -> str:
    return settings.FASTAPI_TITLE


def is_enforced(user: Any) -> bool:
    """按策略这个人是否必须开。没配密钥时不强制（写入侧已经拦了「没密钥还改成强制」，这里是密钥后来被拿掉的兜底）"""
    mode = settings.LOGIN_MFA_ENFORCE
    required = mode == 'all' or (mode == 'superuser' and bool(getattr(user, 'is_superuser', False)))
    if required and not settings.MFA_SECRET_KEY:
        log.error('LOGIN_MFA_ENFORCE 要求二次验证，但没有配置 MFA_SECRET_KEY —— 这次没有强制')
        return False
    return required


async def _row(db: AsyncSession, user_id: int) -> UserMfa | None:
    return await db.scalar(select(UserMfa).where(UserMfa.user_id == user_id))


def _hashes(row: UserMfa) -> list[dict[str, Any]]:
    try:
        return list(json.loads(row.recovery_hashes or '[]'))
    except ValueError:
        return []


def _new_codes() -> tuple[list[str], str]:
    codes = totp.new_recovery_codes()
    return codes, json.dumps([{'h': totp.hash_recovery_code(c), 'used': None} for c in codes])


def _check_code(row: UserMfa, otp: str) -> bool:
    """动态码或恢复码，对了就把用掉的记下（同一个时间片 / 同一个恢复码不能用第二次）。调用方负责提交"""
    secret = _cipher().decrypt(bytes.fromhex(row.secret_cipher))
    step = totp.verify(secret, otp, after_step=row.last_step)
    if step is not None:
        row.last_step = step
        return True
    digest = totp.hash_recovery_code(otp)
    items = _hashes(row)
    for item in items:
        if item.get('used') is None and secrets.compare_digest(item.get('h', ''), digest):
            item['used'] = timezone.to_iso(timezone.now())
            row.recovery_hashes = json.dumps(items)
            return True
    return False


# ── 登录第二步 ────────────────────────────────────────────────────────────────

_CHALLENGE = 'challenge'
_SETUP = 'setup'
_RESERVE_CHALLENGE_ATTEMPT = """
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
    return -1
end
local count = redis.call('INCR', KEYS[2])
if count == 1 then
    redis.call('PEXPIRE', KEYS[2], ttl)
end
if count > tonumber(ARGV[1]) then
    return 0
end
redis.call('INCR', KEYS[3])
redis.call('PEXPIRE', KEYS[3], ttl)
return count
"""
_FINISH_CHALLENGE_ATTEMPT = """
if redis.call('EXISTS', KEYS[1]) == 0 then
    redis.call('DEL', KEYS[2], KEYS[3])
    return 0
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
    return 0
end
local failures = redis.call('INCR', KEYS[2])
if failures == 1 then
    redis.call('PEXPIRE', KEYS[2], ttl)
end
local pending = redis.call('DECR', KEYS[3])
if pending <= 0 and failures >= tonumber(ARGV[1]) then
    redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
    redis.call('DEL', ARGV[2])
    return 1
end
return 0
"""
_CONSUME_CHALLENGE = """
return redis.call('GETDEL', KEYS[1]) or 0
"""


def _key(kind: str, token: str) -> str:
    return f'{settings.MFA_REDIS_PREFIX}:{kind}:{token}'


async def gate(
    db: AsyncSession, user: User, *, client: str, extra: dict[str, Any] | None = None
) -> MfaChallenge | None:
    """身份确认之后调：不需要第二步返回 None（调用方照常开会话）；需要就发令牌"""
    # ⚠️ 强制策略 LOGIN_MFA_ENFORCE 在参数配置里：调用方要先 `load_login_config(db)`（三条登录路径都加载了）。
    # 不在这里加载：测试要能把策略钉住（`no_captcha` 夹具顶掉的是 auth_service 里那个名字）
    enabled = await _row(db, user.id) is not None
    if not enabled and not is_enforced(user):
        return None
    token = secrets.token_urlsafe(32)
    payload = {'user_id': user.id, 'client': client, 'setup': not enabled, **(extra or {})}
    await redis_client.set(_key(_CHALLENGE, token), json.dumps(payload), ex=settings.MFA_CHALLENGE_SECONDS)
    return MfaChallenge(mfa_token=token, mfa_setup=not enabled)


async def _load(token: str) -> dict[str, Any]:
    raw = await redis_client.get(_key(_CHALLENGE, token))
    if not raw:
        raise errors.AuthorizationError(msg=t('error.mfa.challenge_expired'))
    return json.loads(raw)


async def _reserve_attempt(token: str) -> int:
    """在校验 OTP 前原子占用一次名额；过期令牌或超限令牌都不能进入验证码校验。"""
    result = await redis_client.eval(
        _RESERVE_CHALLENGE_ATTEMPT,
        3,
        _key(_CHALLENGE, token),
        _key('attempts', token),
        _key('pending', token),
        str(settings.MFA_CHALLENGE_ATTEMPTS),
    )
    if result < 0 or result == 0:
        raise errors.AuthorizationError(msg=t('error.mfa.challenge_expired'))
    return int(result)


async def _fail(db: AsyncSession, token: str, payload: dict[str, Any]) -> None:
    """错一次：所有占用名额都完成且全部错误时作废令牌。"""
    await redis_client.eval(
        _FINISH_CHALLENGE_ATTEMPT,
        4,
        _key(_CHALLENGE, token),
        _key('failures', token),
        _key('pending', token),
        _key(_SETUP, f'login:{token}'),
        str(settings.MFA_CHALLENGE_ATTEMPTS),
        _key('attempts', token),
    )
    await password_security_service.handle_login_failure(db, int(payload['user_id']))


async def verify_challenge(db: AsyncSession, token: str, otp: str) -> dict[str, Any]:
    """校验第二步，返回令牌里存的东西（`user_id` / `client` / 第一步带来的 `extra`）。对了令牌作废、错了计数"""
    payload = await _load(token)
    if payload.get('setup'):
        # 被强制但还没绑定的令牌只能走绑定，不能拿来「验证」
        raise errors.RequestError(msg=t('error.mfa.setup_required'))
    row = await _row(db, int(payload['user_id']))
    if row is None:
        # 发令牌之后被管理员重置了：重新登录会走绑定
        await redis_client.delete(
            _key(_CHALLENGE, token),
            _key('attempts', token),
            _key('failures', token),
            _key('pending', token),
            _key(_SETUP, f'login:{token}'),
        )
        raise errors.AuthorizationError(msg=t('error.mfa.challenge_expired'))
    await _reserve_attempt(token)
    if not _check_code(row, otp):
        await _fail(db, token, payload)
        raise errors.AuthorizationError(msg=t('error.mfa.invalid_code'))
    consumed = await redis_client.eval(
        _CONSUME_CHALLENGE,
        1,
        _key(_CHALLENGE, token),
    )
    if not consumed:
        await db.rollback()
        raise errors.AuthorizationError(msg=t('error.mfa.challenge_expired'))
    await redis_client.delete(_key('attempts', token), _key('failures', token), _key('pending', token))
    return payload


async def challenge_setup(token: str, user: User) -> MfaSetupInfo:
    """被强制、还没绑的人在登录过程中绑定：先拿密钥和二维码"""
    payload = await _load(token)
    if not payload.get('setup'):
        raise errors.RequestError(msg=t('error.mfa.already_enabled'))
    _cipher()  # 没配密钥就在这一步说清楚，别等到扫完码
    secret = totp.new_secret()
    await redis_client.set(_key(_SETUP, f'login:{token}'), secret, ex=settings.MFA_CHALLENGE_SECONDS)
    return MfaSetupInfo(
        totp_secret=secret, otpauth_uri=totp.provisioning_uri(secret, account=user.username, issuer=_issuer())
    )


async def challenge_enroll(db: AsyncSession, token: str, otp: str) -> tuple[dict[str, Any], MfaRecoveryCodes]:
    """登录过程中的绑定确认：输对一次动态码才算开启，同时作废令牌（调用方接着开会话）"""
    payload = await _load(token)
    if not payload.get('setup'):
        raise errors.RequestError(msg=t('error.mfa.already_enabled'))
    secret = await redis_client.get(_key(_SETUP, f'login:{token}'))
    if not secret:
        raise errors.RequestError(msg=t('error.mfa.setup_expired'))
    await _reserve_attempt(token)
    step = totp.verify(secret, otp)
    if step is None:
        await _fail(db, token, payload)
        raise errors.AuthorizationError(msg=t('error.mfa.invalid_code'))
    consumed = await redis_client.eval(
        _CONSUME_CHALLENGE,
        1,
        _key(_CHALLENGE, token),
    )
    if not consumed:
        await db.rollback()
        raise errors.AuthorizationError(msg=t('error.mfa.challenge_expired'))
    user_id = int(payload['user_id'])
    # 登录还没完成，请求上下文里没有操作人：数据变更记录里要写成「他自己开的」，不是「系统」
    with data_change_source('web', actor_id=user_id):
        codes = await _enable(db, user_id, secret, step)
    await redis_client.delete(
        _key('attempts', token), _key('failures', token), _key('pending', token), _key(_SETUP, f'login:{token}')
    )
    return payload, codes


async def _enable(db: AsyncSession, user_id: int, secret: str, step: int) -> MfaRecoveryCodes:
    if await _row(db, user_id) is not None:
        raise errors.ConflictError(msg=t('error.mfa.already_enabled'))
    codes, hashes = _new_codes()
    db.add(
        UserMfa(
            user_id=user_id,
            secret_cipher=_cipher().encrypt(secret).hex(),
            recovery_hashes=hashes,
            last_step=step,
            enabled_time=timezone.now(),
        )
    )
    await db.flush()
    return MfaRecoveryCodes(recovery_codes=codes)


# ── 个人中心 ─────────────────────────────────────────────────────────────────


class MfaService:
    @staticmethod
    async def status(db: AsyncSession, user: Any) -> GetMfaStatus:
        row = await _row(db, user.id)
        return GetMfaStatus(
            enabled=row is not None,
            enabled_time=row.enabled_time if row else None,
            recovery_remaining=sum(1 for i in _hashes(row) if i.get('used') is None) if row else 0,
            enforced=is_enforced(user),
            available=bool(settings.MFA_SECRET_KEY),
        )

    @staticmethod
    async def start_setup(db: AsyncSession, user: Any) -> MfaSetupInfo:
        if await _row(db, user.id) is not None:
            raise errors.ConflictError(msg=t('error.mfa.already_enabled'))
        _cipher()
        secret = totp.new_secret()
        await redis_client.set(_key(_SETUP, f'user:{user.id}'), secret, ex=settings.MFA_SETUP_SECONDS)
        return MfaSetupInfo(
            totp_secret=secret, otpauth_uri=totp.provisioning_uri(secret, account=user.username, issuer=_issuer())
        )

    @staticmethod
    async def enable(db: AsyncSession, user: Any, otp: str) -> MfaRecoveryCodes:
        """扫完码输一次动态码才算开启 —— 扫了不确认的不算（否则认证器没存上就把自己锁在外面）"""
        secret = await redis_client.get(_key(_SETUP, f'user:{user.id}'))
        if not secret:
            raise errors.RequestError(msg=t('error.mfa.setup_expired'))
        step = totp.verify(secret, otp)
        if step is None:
            raise errors.RequestError(msg=t('error.mfa.invalid_code'))
        codes = await _enable(db, user.id, secret, step)
        await redis_client.delete(_key(_SETUP, f'user:{user.id}'))
        return codes

    @staticmethod
    async def _require_code(db: AsyncSession, user: Any, otp: str) -> UserMfa:
        row = await _row(db, user.id)
        if row is None:
            raise errors.RequestError(msg=t('error.mfa.not_enabled'))
        if not _check_code(row, otp):
            # 已登录的人输错不锁账号（他已经过了一次二次验证），但也不给无限试：走接口限流
            raise errors.RequestError(msg=t('error.mfa.invalid_code'))
        return row

    async def disable(self, db: AsyncSession, user: Any, otp: str) -> None:
        """自己关：要动态码（或恢复码）；被策略强制的人不能关 —— 关了下次登录又被逼着绑，等于白折腾一圈"""
        if is_enforced(user):
            raise errors.ForbiddenError(msg=t('error.mfa.enforced'))
        row = await self._require_code(db, user, otp)
        await db.delete(row)

    async def regenerate_codes(self, db: AsyncSession, user: Any, otp: str) -> MfaRecoveryCodes:
        """旧的恢复码全部作废，换一批新的"""
        row = await self._require_code(db, user, otp)
        codes, hashes = _new_codes()
        row.recovery_hashes = hashes
        return MfaRecoveryCodes(recovery_codes=codes)

    @staticmethod
    async def admin_reset(db: AsyncSession, user_id: int) -> int:
        """管理员重置（手机丢了）：删掉那一行。被强制的人下次登录会走绑定；没被强制的就是关掉了"""
        result = await db.execute(delete(UserMfa).where(UserMfa.user_id == user_id))
        if not result.rowcount:
            # 本来就没开：说清楚，别让管理员以为「重置成功」了
            raise errors.RequestError(msg=t('error.mfa.not_enabled'))
        return result.rowcount


mfa_service: MfaService = MfaService()
