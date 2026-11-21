"""无密码账号「第一次设密码」的身份确认凭据（#402）

第三方登录自动建的号 `sys_user.password` 是 NULL。它改密码时没有「旧密码」可验 —— 原来
`update_password` 对它直接跳过旧密码校验，只是后面构造历史记录时 `password=None` 抛 ValidationError
碰巧把整条路堵死（功能缺陷：这种号永远设不上密码）。把那个异常放过去，就成了「拿到这个人一枚
access token（30 分钟）就能给他设一个长期有效的密码」。

所以第一次设密码要另一种身份证明：**重新走一遍已绑定的第三方授权**（`plugin/oauth2` 的
`GET /oauth2/me/reauth`）。回调确认授权回来的第三方账号就是绑在这个人名下的那一个，才在这里记一笔，
有效期 `TTL_SECONDS`，`update_password` 用 `GETDEL` 原子消费 —— 只能设一次。

放在 admin 而不是 oauth2 插件里：消费方是 admin 的 `user_service`，admin 不能反过来 import 插件。
插件停用时没有人能写入凭据，无密码账号自助设不了密码，只能找超管重置（超管重置不需要这一步）。
"""

from backend.database.redis import redis_client

TTL_SECONDS = 600
_PREFIX = 'fba:user:password_set_grant'


def _key(user_id: int) -> str:
    return f'{_PREFIX}:{user_id}'


async def grant(user_id: int) -> None:
    """第三方重新授权成功：记一笔，`TTL_SECONDS` 内有效"""
    await redis_client.set(_key(user_id), '1', ex=TTL_SECONDS)


async def is_granted(user_id: int) -> bool:
    """给个人中心看「验证过了没有」，不消费"""
    return bool(await redis_client.exists(_key(user_id)))


async def consume(user_id: int) -> bool:
    """原子消费：两个并发请求只有一个拿得到"""
    return bool(await redis_client.getdel(_key(user_id)))
