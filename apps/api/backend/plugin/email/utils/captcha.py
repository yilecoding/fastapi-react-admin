"""Email binding codes are scoped to the account and the validated destination."""

from hashlib import sha256

from backend.core.conf import settings
from backend.database.redis import redis_client

MAX_ATTEMPTS = 5

VERIFY = """
local code = redis.call('GET', KEYS[1])
if not code then return 'expired' end
if code == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2])
  return 'ok'
end
local attempts = redis.call('INCR', KEYS[2])
if attempts == 1 then redis.call('EXPIRE', KEYS[2], redis.call('TTL', KEYS[1])) end
if attempts >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1], KEYS[2]) end
return 'wrong'
"""


def captcha_key(user_id: int, email: str) -> str:
    destination = sha256(email.encode()).hexdigest()
    return f'{settings.EMAIL_CAPTCHA_REDIS_PREFIX}:bind:{user_id}:{destination}'


async def verify_captcha(user_id: int, email: str, code: str) -> str:
    key = captcha_key(user_id, email)
    return await redis_client.eval(VERIFY, 2, key, f'{key}:attempts', code, str(MAX_ATTEMPTS))
