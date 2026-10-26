"""手机验证码：发 + 验（issue #168）

使用方只有两种场景：个人中心绑定手机号（`bind`，第一步）、手机验证码登录（`login`，第二步）。
两者共用这一份，差别只在 `scene` 和 `subject`（绑定按「操作人」隔离，登录按号码本身）。

| 键 | 内容 |
|---|---|
| `fba:sms:captcha:<scene>:<subject>:<phone>` | 验证码本身，TTL = `SMS_CAPTCHA_EXPIRE_SECONDS` |
| `…:attempts` | 这个码已经试错几次，TTL 同上 |

🔴 **验码的比对、删除、错误计数在一段 Lua 里原子完成。** 「先 GET 再比再 DEL」的写法并发能同时穿过：
两条请求都 GET 到同一个码、都比对成功，一个码换两次会话；错误计数也一样，并发试错会让计数少加。
对了就删（一次性），错了计一次，错满 `SMS_CAPTCHA_MAX_ATTEMPTS` 次整个作废 —— 6 位纯数字的空间只有一百万，
不限次数就是可以枚举的。

🔴 **发送失败必须让调用方看到。** 邮件插件 #64 修过同款：吞掉异常返回成功，用户对着一个永远填不对的验证码框等。
`sms_service.send()` 失败抛 `SmsSendError`，这里不接，并且把刚存的码删掉 —— 没发出去的码留着只会让人猜。

验证码用 `secrets` 生成（邮件插件那份用的是 `random.randint(1, 9)`，没有 0、也不是密码学随机），6 位纯数字：
阿里云「验证码类模板变量限制为 4～6 个字符」、腾讯云「只能传入 0 - 6 位纯数字」，6 位两家都收。
"""

from __future__ import annotations

import secrets
import string

from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.sms.service.sms_service import sms_service

#: 验证码位数（两家厂商的验证码类模板都收 6 位纯数字）
CODE_LENGTH = 6

#: KEYS: 码 · 计数；ARGV: 用户填的码 · 最多试错几次。返回 ok / wrong / expired
_VERIFY = """
local code = redis.call('GET', KEYS[1])
if not code then
  return 'expired'
end
if code == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 'ok'
end
local n = redis.call('INCR', KEYS[2])
if n == 1 then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl > 0 then
    redis.call('EXPIRE', KEYS[2], ttl)
  end
end
if n >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1], KEYS[2])
end
return 'wrong'
"""


def captcha_key(scene: str, subject: str, phone: str) -> str:
    return f'{settings.SMS_REDIS_PREFIX}:captcha:{scene}:{subject}:{phone}'


def generate_code() -> str:
    return ''.join(secrets.choice(string.digits) for _ in range(CODE_LENGTH))


class SmsCaptchaService:
    @staticmethod
    async def send(*, scene: str, subject: str, phone: str, user_id: int | None) -> None:
        """生成一个新码、存 Redis、走业务模板 `captcha` 发出去。

        同一个 (scene, subject, phone) 再发一次会**覆盖**旧码（旧码作废），试错计数一起清零 ——
        用户点「重新发送」就是不想要上一个了。频率由 `captcha` 模板声明的冷却 / 号码日上限兜着（`sms_guard`）。

        :raises SmsSendError: 没发出去（被频率防护拦下 / 厂商拒收 / 没有可用配置）。码已删，调用方原样抛给前端
        """
        key = captcha_key(scene, subject, phone)
        code = generate_code()
        await redis_client.set(key, code, ex=settings.SMS_CAPTCHA_EXPIRE_SECONDS)
        await redis_client.delete(f'{key}:attempts')
        try:
            await sms_service.send(
                phone=phone,
                template='captcha',
                params={'code': code, 'minutes': str(max(settings.SMS_CAPTCHA_EXPIRE_SECONDS // 60, 1))},
                user_id=user_id,
            )
        except Exception:
            # 没发出去的码不能留着：留着就是「用户收不到、但接口说发了」
            await redis_client.delete(key, f'{key}:attempts')
            raise

    @staticmethod
    async def verify(*, scene: str, subject: str, phone: str, code: str) -> str:
        """比对一次。返回 `ok`（已消费、不能再用）/ `wrong` / `expired`（没发过、过期了、或已经错满作废）"""
        key = captcha_key(scene, subject, phone)
        result = await redis_client.eval(
            _VERIFY, 2, key, f'{key}:attempts', code, str(settings.SMS_CAPTCHA_MAX_ATTEMPTS)
        )
        return str(result)


sms_captcha_service: SmsCaptchaService = SmsCaptchaService()
