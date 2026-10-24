"""发送频率防护 + 配置日上限计数（Redis，issue #153 第三节第 2 条 / 第二节第 4 条）。

| 控制 | 键 | 规则 |
|---|---|---|
| 冷却 | `fba:sms:cooldown:<template>:<phone>` | 模板声明的 `cooldown_seconds`，`SET NX EX` |
| 号码日上限 | `fba:sms:daily:<template>:<phone>:<yyyymmdd>` | 模板声明的 `daily_max_per_phone` |
| 全站熔断 | `fba:sms:global:<yyyymmddhh>` | `SMS_GLOBAL_HOURLY_MAX`（0 = 不限） |
| 配置日上限 | `fba:sms:config:<id>:<yyyymmdd>` | 配置的 `daily_max`（0 = 不限，但照样计数给「今日已发」用） |

🔴 **三项检查和占位在同一段 Lua 里完成，发送之前占位。** 「先查再发再写」是读写分离的，并发能同时穿过
（AI 确认令牌那条：修复前 5 个并发确认执行了 5 次）。日上限和全站计数**不退还**（发送失败也算一次）；
冷却位只在「确定没发出去」时释放（`UNSENT_KINDS`），`rate_limited` / `unknown` 保留。

日期按 `DATETIME_TIMEZONE` 算（`timezone.now()`），不按 UTC —— 「自然日」是用户所在时区的那一天。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.sms.enums import SmsGuardVerdict
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from backend.plugin.sms.templates import SmsTemplate

#: 日计数键活两天、小时计数键活两小时：跨过边界之后自然过期，不用清
_DAILY_TTL = 2 * 24 * 3600
_HOURLY_TTL = 2 * 3600

#: KEYS: 冷却 · 号码日计数 · 全站小时计数；ARGV: 冷却秒数 · 号码日上限 · 全站小时上限 · 日 TTL · 小时 TTL · 本次的令牌
_ACQUIRE = """
local cooldown, daily_max, global_max = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
if cooldown > 0 and redis.call('EXISTS', KEYS[1]) == 1 then
  return 'cooldown'
end
if daily_max > 0 and tonumber(redis.call('GET', KEYS[2]) or '0') >= daily_max then
  return 'phone_daily'
end
if global_max > 0 and tonumber(redis.call('GET', KEYS[3]) or '0') >= global_max then
  return 'circuit'
end
if cooldown > 0 then
  redis.call('SET', KEYS[1], ARGV[6], 'EX', cooldown)
end
if redis.call('INCR', KEYS[2]) == 1 then
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
end
if redis.call('INCR', KEYS[3]) == 1 then
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[5]))
end
return 'ok'
"""

#: KEYS: 冷却；ARGV: 令牌。只删自己占的那一位：冷却位过期后被别的请求重新占上时，旧请求的释放不能把新位删掉
_RELEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""

#: KEYS: 配置日计数；ARGV: 日上限（0 = 不限）· 日 TTL。超了就退回去，返回 0
_RESERVE_CONFIG = """
local max = tonumber(ARGV[1])
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
if max > 0 and n > max then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
"""


def _day() -> str:
    return timezone.now().strftime('%Y%m%d')


def _hour() -> str:
    return timezone.now().strftime('%Y%m%d%H')


def cooldown_key(template: str, phone: str) -> str:
    return f'{settings.SMS_REDIS_PREFIX}:cooldown:{template}:{phone}'


def phone_daily_key(template: str, phone: str) -> str:
    return f'{settings.SMS_REDIS_PREFIX}:daily:{template}:{phone}:{_day()}'


def global_hourly_key() -> str:
    return f'{settings.SMS_REDIS_PREFIX}:global:{_hour()}'


def config_daily_key(config_id: int) -> str:
    return f'{settings.SMS_REDIS_PREFIX}:config:{config_id}:{_day()}'


class SmsGuard:
    """防刷：占位在发送之前，一段 Lua 原子完成"""

    @staticmethod
    async def acquire(template: SmsTemplate, phone: str, token: str) -> SmsGuardVerdict:
        """占位。`token` 是本次发送的标识，冷却位里存它，释放时只认它（见 `release_cooldown`）"""
        verdict = await redis_client.eval(
            _ACQUIRE,
            3,
            cooldown_key(template.code, phone),
            phone_daily_key(template.code, phone),
            global_hourly_key(),
            str(template.cooldown_seconds),
            str(template.daily_max_per_phone),
            str(max(settings.SMS_GLOBAL_HOURLY_MAX, 0)),
            str(_DAILY_TTL),
            str(_HOURLY_TTL),
            token,
        )
        return SmsGuardVerdict(verdict)

    @staticmethod
    async def release_cooldown(template: SmsTemplate, phone: str, token: str) -> None:
        """确定没发出去：把冷却位还回去，用户马上能再试

        🔴 不能无条件 `DEL`：连接超时（最长 = 配置的 `timeout`，上限 60 秒）可能和冷却时长一样长，
        等它判定「没连上」时自己占的位早已过期、另一条请求已经重新占上 —— 裸删等于把别人的冷却位删掉，
        第三条就能穿过去。只删值等于本次令牌的那一位（compare-and-delete，Lua 原子）。
        """
        if template.cooldown_seconds > 0:
            await redis_client.eval(_RELEASE, 1, cooldown_key(template.code, phone), token)

    @staticmethod
    async def reserve_config(config_id: int, daily_max: int) -> bool:
        """给这条配置今天的计数 +1；到了 `daily_max` 就退回并返回 False（调用方换下一个候选）"""
        return bool(
            await redis_client.eval(
                _RESERVE_CONFIG, 1, config_daily_key(config_id), str(max(daily_max, 0)), str(_DAILY_TTL)
            )
        )

    @staticmethod
    async def today_sent(config_ids: list[int]) -> dict[int, int]:
        """配置页「今日已发」"""
        if not config_ids:
            return {}
        values = await redis_client.mget([config_daily_key(pk) for pk in config_ids])
        return {pk: int(v or 0) for pk, v in zip(config_ids, values, strict=True)}


sms_guard: SmsGuard = SmsGuard()
