"""
登录会话（#138）：一次登录就是一个会话，从登录到登出 / 被踢 / 空闲 / 到期，**会话 ID 不变**。

Redis 里的形状：

- `fba:session:{sid}` —— hash，会话本身（字段见 `SessionStore.create`）
- `fba:session_user:{uid}` —— ZSET，这个人的全部会话，分值 = 最后活跃（挤人时挑分值最小的）
- `fba:session_all` —— ZSET，全站会话（在线用户页读它，不再 SCAN access token 的 key）
- `fba:session_end:{sid}` —— 会话为什么结束，给被踢的那一方报原因

refresh token = `{sid}.{secret}`。Redis 里只存 secret 的 HMAC 指纹（当前 + 上一代），轮换只换 secret：

- 出示当前这一代 → 换一代，旧的降为「上一代」
- 宽限期内出示上一代 → **回放同一组新令牌**（新 secret 加密存着）。多标签页同时刷新、弱网重试都靠它
- 宽限期外出示上一代 → 判盗用，撤销会话（`EndReason.reuse`）
- 出示一个对不上的 secret → 只回 401，**不撤销**：sid 不是秘密，不能让人凭 sid 把别人踢下线

两道上限：**绝对有效期**（登录时刻起算，轮换不延长）和**空闲超时**（按人有没有在操作算，
见 `middleware/jwt_auth_middleware.py: client_idle`）。会话 key 的 TTL = 两者先到的那个 +
`SESSION_END_REASON_TTL_SECONDS`：多留这一段是为了用户回来时还能说出「因为空闲」，而不是一句笼统的「过期」。

🔴 轮换、准入（数上限 + 挤人 + 建会话）、续活跃、撤销都是 Lua 脚本，原子执行，不加用户级锁。
脚本里按前缀拼 key —— 这假设 Redis 是单实例；上 Cluster 要给同一用户的 key 加 `{uid}` hash tag。
"""

import dataclasses
import hashlib
import hmac
import re
import secrets
import time
import uuid

from typing import Any

from backend.common.enums import StrEnum
from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.log import log
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.utils.encrypt import AESCipher


class SessionClient(StrEnum):
    """登录端。客户端自报，只用来选时长和上限（`SESSION_{端}_*`），不决定任何安全相关的行为"""

    web = 'web'
    desktop = 'desktop'
    mobile = 'mobile'
    # swagger 调试口（非 prod）。只发 access token、不续期、不计入上限、不进在线列表
    swagger = 'swagger'


class EndReason(StrEnum):
    """会话为什么结束。随 401 的 `data.reason` 下发，前端按它出提示"""

    logout = 'logout'  # 自己登出（同一个浏览器里的其它标签页会收到）
    kicked = 'kicked'  # 管理员强制下线
    replaced = 'replaced'  # 超过会话上限被挤掉 / 同一个浏览器重新登录
    idle = 'idle'  # 空闲超时
    expired = 'expired'  # 到了绝对有效期；会话已经不在、又查不到原因时也报这个
    reuse = 'reuse'  # 上一代 refresh token 在宽限期外又被出示 —— 凭据可能被盗了
    password_changed = 'password_changed'
    disabled = 'disabled'  # 账号被停用 / 删除


@dataclasses.dataclass(frozen=True)
class SessionPolicy:
    idle_seconds: int
    absolute_seconds: int
    max_sessions: int  # 0 = 不限
    overflow: str  # evict_idle | deny


@dataclasses.dataclass
class IssuedSession:
    """登录 / 刷新之后交给调用方的东西"""

    user_id: int
    session_uuid: str
    refresh_token: str
    expire_at: int  # 绝对有效期（epoch 秒）


def policy_for(client: str) -> SessionPolicy:
    """按端取策略。读的是 `settings`，参数配置「会话策略」组已经在登录时覆盖进来了（`load_session_config`）"""
    if client == SessionClient.swagger:
        lifetime = settings.SESSION_SWAGGER_SECONDS
        return SessionPolicy(idle_seconds=lifetime, absolute_seconds=lifetime, max_sessions=0, overflow='evict_idle')
    prefix = f'SESSION_{client.upper()}'
    return SessionPolicy(
        idle_seconds=getattr(settings, f'{prefix}_IDLE_MINUTES') * 60,
        absolute_seconds=getattr(settings, f'{prefix}_ABSOLUTE_DAYS') * 86400,
        max_sessions=getattr(settings, f'{prefix}_MAX'),
        overflow=getattr(settings, f'{prefix}_OVERFLOW'),
    )


def _plain(value: Any) -> str:
    """枚举一律取 `.value` 再转字符串。

    🔴 本仓库的 `StrEnum` 是 `(str, Enum)` 那种老写法，`str()` / f-string 给的是
    `EndReason.idle` 而不是 `idle`：写进 Redis 的结束原因、拼出来的文案 key 会一起变成那个样子，
    回头查原因对不上、退回成笼统的「到期」（实测踩到：文案 key 拼成了 `error.session.EndReason.expired`）
    """
    return str(getattr(value, 'value', value))


def ended_error(reason: str) -> errors.TokenError:
    """会话结束的 401：文案 + 原因码"""
    reason = _plain(reason)
    return errors.TokenError(msg=t(f'error.session.{reason}'), reason=reason)


#: sid 和 secret 都会被拼进 Redis key / 比对，先卡形状（同分片上传的 upload_id）
_SID_RE = re.compile(r'^[0-9a-f]{32}$')
_SECRET_RE = re.compile(r'^[A-Za-z0-9_-]{43}$')


def split_refresh_token(raw: str | None) -> tuple[str, str] | None:
    """`{sid}.{secret}` → (sid, secret)；形状不对返回 None（#138 之前的 JWT 格式也落在这里）"""
    if not raw:
        return None
    sid, _, secret = raw.partition('.')
    if not _SID_RE.match(sid) or not _SECRET_RE.match(secret):
        return None
    return sid, secret


def _derive_key(label: str) -> bytes:
    # 两把派生密钥各管一件事：签 access token 的那把不直接拿来做别的
    return hashlib.sha256(f'{label}:{settings.TOKEN_SECRET_KEY}'.encode()).digest()


def _fingerprint(secret: str) -> str:
    return hmac.new(_derive_key('fba-refresh-fingerprint'), secret.encode(), hashlib.sha256).hexdigest()


def _cipher() -> AESCipher:
    # 加密存「当前这一代」的 secret，宽限期回放要原样再给一次。Redis 被读走也拿不到能用的令牌
    return AESCipher(_derive_key('fba-refresh-replay'))


def _now() -> int:
    return int(time.time())


def _key_ttl(now: int, *, active: int, idle: int, expire_at: int) -> int:
    """会话 key 的 TTL：空闲 / 绝对两道上限先到的那个，再多留一段好报原因"""
    ends_at = min(active + idle, expire_at)
    return max(ends_at - now, 1) + settings.SESSION_END_REASON_TTL_SECONDS


def _prefix_args() -> list[str]:
    return [
        settings.SESSION_REDIS_PREFIX,
        settings.SESSION_USER_INDEX_PREFIX,
        settings.SESSION_ALL_INDEX_KEY,
        settings.SESSION_END_REDIS_PREFIX,
        str(settings.SESSION_END_REASON_TTL_SECONDS),
    ]


# ─── Lua 脚本 ──────────────────────────────────────────────────────────────────
# 前 5 个 ARGV 一律是 `_prefix_args()`：会话前缀 / 用户索引前缀 / 全站索引 / 原因前缀 / 原因 TTL

#: 准入：清掉索引里已经消失的会话 → 数同一端的会话 → 超限就挤人或拒绝 → 建会话
#: ARGV[6..] = uid, sid, client, now, max, overflow, key_ttl, index_ttl, 然后是 hash 的 field/value
_ADMIT = """
local sp, up, all, ep, ettl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
local uid, sid, client = ARGV[6], ARGV[7], ARGV[8]
local now, max, overflow = tonumber(ARGV[9]), tonumber(ARGV[10]), ARGV[11]
local ttl, index_ttl = tonumber(ARGV[12]), tonumber(ARGV[13])
local uidx = up .. ':' .. uid

-- ZRANGE 按分值（最后活跃）升序，same[1] 就是最久没活跃的那个
local same = {}
for _, m in ipairs(redis.call('ZRANGE', uidx, 0, -1)) do
  local c = redis.call('HGET', sp .. ':' .. m, 'client')
  if not c then
    redis.call('ZREM', uidx, m)
    redis.call('ZREM', all, m)
  elseif c == client then
    same[#same + 1] = m
  end
end

local evicted = {}
if max > 0 and #same >= max then
  if overflow == 'deny' then
    return {'deny', tostring(#same)}
  end
  for i = 1, #same - max + 1 do
    local victim = same[i]
    redis.call('DEL', sp .. ':' .. victim)
    redis.call('ZREM', uidx, victim)
    redis.call('ZREM', all, victim)
    redis.call('SET', ep .. ':' .. victim, 'replaced', 'EX', ettl)
    evicted[#evicted + 1] = victim
  end
end

local skey = sp .. ':' .. sid
redis.call('HSET', skey, unpack(ARGV, 14))
redis.call('EXPIRE', skey, ttl)
redis.call('ZADD', uidx, now, sid)
redis.call('ZADD', all, now, sid)
if redis.call('TTL', uidx) < index_ttl then
  redis.call('EXPIRE', uidx, index_ttl)
end
local out = {'ok'}
for _, v in ipairs(evicted) do out[#out + 1] = v end
return out
"""

#: 轮换。ARGV[6..] = sid, 出示的指纹, 新指纹, 新 secret 的密文, now, 宽限期
#: 返回 {状态, uid, 绝对到期[, 回放用的密文]}；状态 ∈ ok / replay / mismatch / gone / 结束原因
_ROTATE = """
local sp, up, all, ep, ettl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
local sid, fp, new_fp, new_enc = ARGV[6], ARGV[7], ARGV[8], ARGV[9]
local now, grace = tonumber(ARGV[10]), tonumber(ARGV[11])
local skey = sp .. ':' .. sid
local s = redis.call(
  'HMGET', skey, 'uid', 'fp_cur', 'fp_prev', 'rotated_at', 'enc_cur', 'expire_at', 'idle', 'last_active'
)
if not s[1] then
  return {'gone'}
end

local function finish(reason)
  redis.call('DEL', skey)
  redis.call('ZREM', up .. ':' .. s[1], sid)
  redis.call('ZREM', all, sid)
  redis.call('SET', ep .. ':' .. sid, reason, 'EX', ettl)
  return {reason, s[1]}
end

if now >= tonumber(s[6]) then return finish('expired') end
if now - tonumber(s[8]) > tonumber(s[7]) then return finish('idle') end

if fp == s[2] then
  redis.call('HSET', skey, 'fp_prev', s[2], 'fp_cur', new_fp, 'enc_cur', new_enc, 'rotated_at', ARGV[10])
  return {'ok', s[1], s[6]}
end
if s[3] and fp == s[3] then
  if now - tonumber(s[4]) <= grace then
    return {'replay', s[1], s[6], s[5]}
  end
  return finish('reuse')
end
return {'mismatch', s[1]}
"""

#: 续活跃：只往后挪，会话已经不在就什么都不做（不能把一个刚被撤销的会话写回来半截）
#: ARGV[6..] = sid, active, key_ttl
_TOUCH = """
local sp, up, all = ARGV[1], ARGV[2], ARGV[3]
local sid, active, ttl = ARGV[6], tonumber(ARGV[7]), tonumber(ARGV[8])
local skey = sp .. ':' .. sid
local s = redis.call('HMGET', skey, 'uid', 'last_active')
if not s[1] or tonumber(s[2]) >= active then
  return 0
end
redis.call('HSET', skey, 'last_active', ARGV[7])
redis.call('EXPIRE', skey, ttl)
redis.call('ZADD', up .. ':' .. s[1], 'XX', active, sid)
redis.call('ZADD', all, 'XX', active, sid)
return 1
"""

#: 撤销一个会话并记下原因。ARGV[6..] = sid, reason；返回会话原来在不在
_REVOKE = """
local sp, up, all, ep, ettl = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5])
local sid, reason = ARGV[6], ARGV[7]
local skey = sp .. ':' .. sid
local uid = redis.call('HGET', skey, 'uid')
if not uid then
  return 0
end
redis.call('DEL', skey)
redis.call('ZREM', up .. ':' .. uid, sid)
redis.call('ZREM', all, sid)
redis.call('SET', ep .. ':' .. sid, reason, 'EX', ettl)
return 1
"""


async def _run(script: str, *args: Any) -> Any:
    # 每次 EVAL 整段脚本：几百字节，省掉 register_script 在「换了事件循环的测试客户端」上的那层缓存问题
    return await redis_client.eval(script, 0, *_prefix_args(), *[_plain(a) for a in args])


async def _notify_ended(session_uuid: str, reason: str) -> None:
    """推给这个会话的 socket 连接：告诉它为什么结束、然后断开。推不出去不影响撤销本身"""
    # 延迟导入：socketio.server 依赖 jwt，jwt 依赖本模块
    from backend.common.socketio.actions import session_ended

    try:
        await session_ended(session_uuid, _plain(reason))
    except Exception as e:
        log.warning(f'会话 {session_uuid} 的下线通知没推出去：{e}')


class SessionStore:
    """会话的全部读写都在这里。别处不要直接碰 `fba:session*` 的 key"""

    @staticmethod
    async def create(*, user_id: int, client: str, meta: dict[str, str]) -> IssuedSession:
        """
        建一个会话（登录）。同一端超过上限时按策略挤掉最久没活跃的，或者拒绝

        :param user_id: 用户 ID
        :param client: 登录端（`SessionClient`）
        :param meta: 在线用户页要展示的东西（用户名 / IP / 浏览器 …），原样存进会话
        :return:
        """
        client = _plain(client)
        policy = policy_for(client)
        now = _now()
        sid = uuid.uuid4().hex
        secret = secrets.token_urlsafe(32)
        expire_at = now + policy.absolute_seconds
        fields = {
            'uid': user_id,
            'client': client,
            'created_at': now,
            'expire_at': expire_at,
            'idle': policy.idle_seconds,
            'last_active': now,
            'fp_cur': _fingerprint(secret),
            **{k: v or '' for k, v in meta.items()},
        }
        result = await _run(
            _ADMIT,
            user_id,
            sid,
            client,
            now,
            policy.max_sessions,
            policy.overflow,
            _key_ttl(now, active=now, idle=policy.idle_seconds, expire_at=expire_at),
            policy.absolute_seconds + settings.SESSION_END_REASON_TTL_SECONDS,
            *[x for pair in fields.items() for x in pair],
        )
        if result[0] == 'deny':
            raise errors.ForbiddenError(
                msg=t('error.session.limit_reached', client=t(f'session.client.{client}'), n=policy.max_sessions)
            )
        for victim in result[1:]:
            await _notify_ended(victim, EndReason.replaced)
        return IssuedSession(user_id=user_id, session_uuid=sid, refresh_token=f'{sid}.{secret}', expire_at=expire_at)

    @staticmethod
    async def rotate(raw: str | None) -> IssuedSession:
        """
        用 refresh token 换一代（刷新）

        :param raw: cookie 里的 refresh token
        :return: 新的 refresh token；宽限期内的重复出示拿到的是同一个
        :raises errors.TokenError: 会话结束 / 凭据不对，`reason` 说明为什么
        """
        parts = split_refresh_token(raw)
        if parts is None:
            raise ended_error(EndReason.expired)
        sid, secret = parts
        new_secret = secrets.token_urlsafe(32)
        result = await _run(
            _ROTATE,
            sid,
            _fingerprint(secret),
            _fingerprint(new_secret),
            _cipher().encrypt(new_secret).hex(),
            _now(),
            settings.SESSION_REFRESH_GRACE_SECONDS,
        )
        status = result[0]
        if status == 'ok':
            return IssuedSession(
                user_id=int(result[1]),
                session_uuid=sid,
                refresh_token=f'{sid}.{new_secret}',
                expire_at=int(result[2]),
            )
        if status == 'replay':
            replayed = _cipher().decrypt(result[3])
            return IssuedSession(
                user_id=int(result[1]),
                session_uuid=sid,
                refresh_token=f'{sid}.{replayed}',
                expire_at=int(result[2]),
            )
        if status == 'mismatch':
            # 🔴 不撤销：sid 写在 cookie 里、日志里都看得见，凭一个 sid 就能把人踢下线是送上门的 DoS
            raise errors.TokenError(msg=t('error.session.invalid'), reason='invalid')
        if status == 'gone':
            raise ended_error(await SessionStore.end_reason(sid))
        # 脚本已经撤销了（到期 / 空闲 / 盗用），这里只负责通知和报错
        if status == EndReason.reuse:
            log.warning(f'会话 {sid} 的上一代 refresh token 在宽限期外被再次出示，已撤销整个会话')
        await _notify_ended(sid, status)
        raise ended_error(status)

    @staticmethod
    async def check(*, user_id: int, session_uuid: str, client_idle: int | None, touch: bool) -> None:
        """
        每个带 access token 的请求都过这里：会话还在不在、到没到期、空闲了没有，顺手续活跃

        :param user_id: access token 里的用户 ID
        :param session_uuid: access token 里的会话 ID
        :param client_idle: 客户端自报的「多少秒没操作了」；None = 没报，按刚操作过算
        :param touch: 这次请求算不算用户在操作（socket 握手不算）
        :raises errors.TokenError:
        """
        uid, expire_at, idle, last_active = await redis_client.hmget(
            f'{settings.SESSION_REDIS_PREFIX}:{session_uuid}', 'uid', 'expire_at', 'idle', 'last_active'
        )
        if uid is None:
            raise ended_error(await SessionStore.end_reason(session_uuid))
        if int(uid) != user_id:
            raise errors.TokenError(msg=t('error.token.invalid'))
        now = _now()
        expire_at, idle, last_active = int(expire_at), int(idle), int(last_active)
        if now >= expire_at:
            await SessionStore.revoke(session_uuid, EndReason.expired)
            raise ended_error(EndReason.expired)
        active = last_active
        if touch:
            # 自报的空闲比会话还老也不会让 active 倒退到 last_active 之前（取 max）
            active = max(last_active, now - min(client_idle or 0, now))
        if now - active > idle:
            await SessionStore.revoke(session_uuid, EndReason.idle)
            raise ended_error(EndReason.idle)
        if touch and active - last_active >= settings.SESSION_ACTIVITY_WRITE_SECONDS:
            await _run(_TOUCH, session_uuid, active, _key_ttl(now, active=active, idle=idle, expire_at=expire_at))

    @staticmethod
    async def owner_of(raw: str | None) -> tuple[int, str] | None:
        """
        这枚 refresh token 属于哪个会话（登出 / 同浏览器重登用）

        只认当前或上一代 secret：sid 不是秘密，光凭 sid 就能撤销别人的会话等于送一个 DoS

        :param raw: refresh token
        :return: (user_id, session_uuid)；对不上返回 None
        """
        parts = split_refresh_token(raw)
        if parts is None:
            return None
        sid, secret = parts
        uid, fp_cur, fp_prev = await redis_client.hmget(
            f'{settings.SESSION_REDIS_PREFIX}:{sid}', 'uid', 'fp_cur', 'fp_prev'
        )
        if uid is None:
            return None
        fp = _fingerprint(secret)
        if hmac.compare_digest(fp, fp_cur or '') or hmac.compare_digest(fp, fp_prev or ''):
            return int(uid), sid
        return None

    @staticmethod
    async def user_of(session_uuid: str) -> int | None:
        """会话属于谁；会话不在了返回 None"""
        uid = await redis_client.hget(f'{settings.SESSION_REDIS_PREFIX}:{session_uuid}', 'uid')
        return int(uid) if uid is not None else None

    @staticmethod
    async def end_reason(session_uuid: str) -> str:
        """会话为什么不在了；查不到（原因已过期 / 从没记过）就报到期"""
        reason = await redis_client.get(f'{settings.SESSION_END_REDIS_PREFIX}:{session_uuid}')
        return reason if reason in {r.value for r in EndReason} else EndReason.expired

    @staticmethod
    async def revoke(session_uuid: str, reason: str, *, notify: bool = True) -> bool:
        """
        撤销一个会话：删会话、摘索引、记原因、推 socket

        🔴 所有「让某个会话失效」的入口都走这里。#138 之前有 7 个文件各自删 token key，
        其中一处只删了 access 没删 refresh —— 被踢的人刷新一下就回来了

        :param session_uuid: 会话 ID
        :param reason: `EndReason`
        :param notify: 推不推 socket（同一个请求里马上要建新会话的场景不用推）
        :return: 会话原来在不在
        """
        existed = bool(await _run(_REVOKE, session_uuid, reason))
        if existed and notify:
            await _notify_ended(session_uuid, reason)
        return existed

    @staticmethod
    async def revoke_user(user_id: int, reason: str, *, except_session: str | None = None) -> int:
        """
        撤销一个用户的全部会话（改密码 / 停用 / 删除）

        :param user_id: 用户 ID
        :param reason: `EndReason`
        :param except_session: 留下哪一个（一般是发起这次操作的那个）
        :return: 撤销了几个
        """
        sids = await redis_client.zrange(f'{settings.SESSION_USER_INDEX_PREFIX}:{user_id}', 0, -1)
        count = 0
        for sid in sids:
            if sid != except_session and await SessionStore.revoke(sid, reason):
                count += 1
        return count

    @staticmethod
    async def list_active() -> list[dict[str, Any]]:
        """
        全站还活着的会话，最近活跃的在前（在线用户页）

        已经过了空闲 / 绝对上限、只是 key 还没过期的不算（那一段是留着报原因的）；
        key 已经没了的顺手从索引里摘掉

        :return: 每个会话的 hash，外加 `session_uuid`
        """
        sids = await redis_client.zrevrange(settings.SESSION_ALL_INDEX_KEY, 0, -1)
        if not sids:
            return []
        async with redis_client.pipeline(transaction=False) as pipe:
            for sid in sids:
                pipe.hgetall(f'{settings.SESSION_REDIS_PREFIX}:{sid}')
            rows = await pipe.execute()
        now = _now()
        alive, dead = [], []
        for sid, row in zip(sids, rows, strict=True):
            if not row:
                dead.append(sid)
                continue
            if now >= int(row['expire_at']) or now - int(row['last_active']) > int(row['idle']):
                continue
            alive.append({**row, 'session_uuid': sid})
        if dead:
            await redis_client.zrem(settings.SESSION_ALL_INDEX_KEY, *dead)
        return alive


session_store: SessionStore = SessionStore()
