"""认证接口的安全边界。

这批用例守的是「登录这条路上不能泄漏什么、不能被谁拖住」，不是功能正确性：

- **用户枚举**：账号不存在和密码错误必须在状态码、文案、**耗时**三个维度上不可区分。
  前两个是代码问题，第三个是 bcrypt 的物理性质 —— 实测 cost=12 时一次 verify 约
  190ms，而「查无此人」只有一次 SELECT 约 5ms，40 倍差距不需要任何统计手段。
- **锁定信息的时机**：账号被停用/锁定这件事只能在密码正确之后才说。说早了，
  攻击者不用密码就能枚举，而且能拿错误密码锁死任意账号。
- **swagger 调试口**：它在 prod 必须根本不存在。

⚠️ 限流默认被 conftest 的 `_disable_rate_limiter` 关掉（同一个 IP 反复登录会互相打架），
要验 429 的用例显式带 `rate_limiter` fixture。
"""

import asyncio
import time

from collections.abc import Iterator

import pytest

from httpx import Response
from starlette.testclient import TestClient

from backend.conftest import PYTEST_PASSWORD, PYTEST_USERNAME
from backend.core.conf import settings
from backend.database.redis import RedisCli

_NO_SUCH_USER = 'no-such-user-3f9a2b7c'


@pytest.fixture(autouse=True)
def _clear_login_counters() -> Iterator[None]:
    """每条用例前后清掉失败计数和锁定标记

    本模块**故意**制造大量失败登录，而 USER_LOCK_THRESHOLD 是 5 —— 不清的话
    第 6 条用例开始 admin 就是被锁状态，后面的断言全在验证一个无关的事实。
    （反过来说，这个 fixture 存在本身就证明锁定是生效的。）
    """

    # ⚠️ 不能复用全局 `redis_client` —— 它绑在 TestClient 的事件循环上，
    # 从 `asyncio.run()` 新起的循环里用它会 "attached to a different loop"。
    # 每次开一个短连接，用完就关。
    async def _flush() -> None:
        client = RedisCli()
        try:
            for prefix in (
                settings.LOGIN_FAILURE_PREFIX,
                settings.USER_LOCK_REDIS_PREFIX,
                settings.LOGIN_IP_FAILURE_PREFIX,
                settings.REQUEST_LIMITER_REDIS_PREFIX,
            ):
                keys = await client.keys(f'{prefix}*')
                if keys:
                    await client.delete(*keys)
        finally:
            await client.aclose()

    asyncio.run(_flush())
    yield
    asyncio.run(_flush())


def _swagger_login(client: TestClient, username: str, password: str) -> Response:
    return client.post('/auth/login/swagger', params={'username': username, 'password': password})


def test_logout(client: TestClient, token_headers: dict[str, str]) -> None:
    response = client.post('/auth/logout', headers=token_headers)
    assert response.status_code == 200
    assert response.json()['code'] == 200


def test_unknown_user_and_wrong_password_are_indistinguishable(client: TestClient) -> None:
    """状态码 + 业务码 + 文案三者必须完全一致

    原来「用户不存在」抛 NotFoundError(404)、「密码错」抛 AuthorizationError(403)。
    文案早就统一成「用户名或密码有误」了，但状态码的差异让枚举照样成立。
    """
    unknown = _swagger_login(client, _NO_SUCH_USER, 'whatever')
    wrong = _swagger_login(client, PYTEST_USERNAME, 'definitely-not-the-password')

    assert unknown.status_code == wrong.status_code == 403
    assert unknown.json()['code'] == wrong.json()['code']
    assert unknown.json()['msg'] == wrong.json()['msg']


def test_login_timing_does_not_leak_user_existence(client: TestClient) -> None:
    """两种失败的耗时必须接近，且都要真的跑过一次 bcrypt

    只断言「差值小」是不够的：把两边都改成不跑 bcrypt 也能让差值变小，
    但那样等于删掉了密码校验。所以同时要求两者都 > 50ms —— 证明哑 hash
    确实执行了，而不是两边一起变快。
    """

    def median_ms(username: str) -> float:
        samples = []
        for _ in range(5):
            start = time.perf_counter()
            _swagger_login(client, username, 'definitely-not-the-password')
            samples.append((time.perf_counter() - start) * 1000)
        return sorted(samples)[len(samples) // 2]

    unknown_ms = median_ms(_NO_SUCH_USER)
    wrong_ms = median_ms(PYTEST_USERNAME)

    assert unknown_ms > 50, f'查无此人只花了 {unknown_ms:.0f}ms —— 哑 hash 没跑，时间侧信道还在'
    assert wrong_ms > 50, f'密码错只花了 {wrong_ms:.0f}ms —— bcrypt 没跑？'
    assert abs(unknown_ms - wrong_ms) < 80, (
        f'两种失败耗时差 {abs(unknown_ms - wrong_ms):.0f}ms（{unknown_ms:.0f} vs {wrong_ms:.0f}）'
    )


def test_wrong_password_does_not_reveal_account_lock(client: TestClient) -> None:
    """密码不对时，无论账号是否被锁，回的都是同一句「用户名或密码有误」

    守的是 `peek_lock_reason` 不能被挪回密码校验之前。挪回去会同时带来
    用户枚举和「5 次错密码锁死任意账号」的 DoS。
    """
    resp = _swagger_login(client, PYTEST_USERNAME, 'definitely-not-the-password')
    assert resp.status_code == 403
    body = resp.json()
    assert '锁定' not in body['msg'], f'密码错却透露了锁定状态：{body["msg"]}'


def test_correct_password_still_works(client: TestClient) -> None:
    """改造不能把正常登录改坏"""
    resp = _swagger_login(client, PYTEST_USERNAME, PYTEST_PASSWORD)
    assert resp.status_code == 200
    assert resp.json()['access_token']


def test_swagger_login_is_rate_limited(client: TestClient, rate_limiter: None) -> None:
    """swagger 口必须和主登录一样受限流

    它原来一条限流都没有：无验证码、无日志、会话还被排除出「在线用户」列表，
    是一条比主登录好用得多的爆破入口。
    """
    codes = [_swagger_login(client, _NO_SUCH_USER, 'x').status_code for _ in range(7)]
    assert 429 in codes, f'连打 7 次都没被限流，实际状态码：{codes}'
    limited = next(c for c in codes if c == 429)
    assert limited == 429


@pytest.mark.parametrize('env', ['prod'])
def test_swagger_login_is_not_registered_in_prod(env: str) -> None:
    """prod 下这条路由必须**根本不存在**

    不是「handler 里返回 403」—— 路由不存在，依赖就不会解析，攻击面为零，
    且 404 与「这个 API 不存在」一致，不确认功能存在。

    这条是防「以后有人把路由挪出那个 if」的支点，所以直接断言注册逻辑本身：
    重新导入路由模块，检查 prod 下有没有这条 path。
    """
    import importlib

    from backend.core.conf import settings

    original = settings.ENVIRONMENT
    settings.ENVIRONMENT = env
    try:
        module = importlib.reload(importlib.import_module('backend.app.admin.api.v1.auth.auth'))
        paths = {route.path for route in module.router.routes}
        assert '/login/swagger' not in paths, 'prod 下 swagger 调试口仍然被注册了'
        assert '/login' in paths, '正常登录口不该被一起关掉'
    finally:
        settings.ENVIRONMENT = original
        # 还原模块状态，否则后面的用例会跑在 prod 版路由表上
        importlib.reload(importlib.import_module('backend.app.admin.api.v1.auth.auth'))
