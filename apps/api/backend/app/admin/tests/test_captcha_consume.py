"""issue #229：图形验证码答错也要作废

原来 `_verify_graphical_captcha` 只在答对时删 key，同一张图在 5 分钟有效期里可以反复猜。
这个函数被密码登录和「手机号发码」两个匿名接口共用，后者是防短信轰炸的那道门。

用字典打桩 Redis：只验「每张图只能试一次」这一条，不碰真实连接（全局 Redis 客户端绑在别的事件循环上）。
"""

import asyncio

import pytest

from backend.app.admin.service import auth_service as auth_module
from backend.common.exception import errors
from backend.core.conf import settings


class _FakeRedis:
    def __init__(self, data: dict[str, str]) -> None:
        self.data = data

    async def get(self, key: str) -> str | None:
        return self.data.get(key)

    async def delete(self, key: str) -> int:
        return 1 if self.data.pop(key, None) is not None else 0


@pytest.fixture
def fake_redis(monkeypatch: pytest.MonkeyPatch) -> _FakeRedis:
    monkeypatch.setattr(settings, 'LOGIN_CAPTCHA_ENABLED', True)
    fake = _FakeRedis({f'{settings.LOGIN_CAPTCHA_REDIS_PREFIX}:u1': 'AbCd'})
    monkeypatch.setattr(auth_module, 'redis_client', fake)
    return fake


def _verify(captcha: str) -> None:
    asyncio.run(auth_module.AuthService._verify_graphical_captcha('u1', captcha))


def test_wrong_answer_burns_the_captcha(fake_redis: _FakeRedis) -> None:
    with pytest.raises(errors.CustomError):
        _verify('xxxx')
    # 第二次哪怕答对，也只能拿到「已过期」—— 这张图已经作废
    with pytest.raises(errors.RequestError):
        _verify('abcd')


def test_right_answer_passes_once(fake_redis: _FakeRedis) -> None:
    _verify('abcd')  # 不区分大小写
    assert not fake_redis.data, '答对之后同样要消费'
    with pytest.raises(errors.RequestError):
        _verify('abcd')
