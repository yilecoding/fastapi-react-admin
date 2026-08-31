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


# ─── 会话撤销：登出与强制下线 ─────────────────────────────────────────────────
#
# 这一组守的是同一件事：**撤销一个会话时 refresh token 必须一起死。**
# 两个 bug 都是静默的 —— 界面上该消失的都消失了，人还在。


@pytest.fixture
def no_captcha(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """让 `/auth/login` 不走验证码

    ⚠️ 光设 `settings.LOGIN_CAPTCHA_ENABLED = False` 不够：`login()` 第一句就是
    `await load_login_config(db)`，它会把 **sys_config 表里的值** setattr 回 settings
    （`utils/dynamic_config.py`）。而那张表在 fba_test 里是什么值，取决于上一次
    E2E 的 global-setup 有没有跑过 —— 依赖它就是依赖一个看不见的外部状态。
    所以连那次加载一起顶掉。
    """

    async def _noop(_db: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async，签名要对上
        return None

    monkeypatch.setattr('backend.app.admin.service.auth_service.load_login_config', _noop)
    original = settings.LOGIN_CAPTCHA_ENABLED
    settings.LOGIN_CAPTCHA_ENABLED = False
    try:
        yield
    finally:
        settings.LOGIN_CAPTCHA_ENABLED = original


@pytest.fixture
def session(client: TestClient, no_captcha: None) -> Iterator[tuple[dict[str, str], str]]:
    """走**真实** `/auth/login` 建一个带 refresh cookie 的会话

    返回 `(auth_headers, session_uuid)`；refresh cookie 留在 client 的 jar 里，
    用例只要**不传 Authorization** 就等价于桌面端发出的那个请求。

    ⚠️ 不能用 `/auth/login/swagger`：它只发 access token，`create_refresh_token`
    根本没被调用（`auth_service.swagger_login`），拿它来测 refresh 撤销等于什么都没测。

    🔴 **也不能自己再 `TestClient(app)` 开一个。** `TestClient` 作为上下文管理器会
    跑一遍应用的 lifespan，而 `conftest` 里那个 `client` 是 **session 级**、全程开着的 ——
    第二个实例退出时的 shutdown 会把共享的 Redis / 数据库连接一起关掉，
    后面所有用例都受牵连，而报出来的错和这里毫无关系。

    ⚠️ cookie 挂在 client 实例上而不是逐请求传 `cookies=` —— 后者在 httpx 里已废弃
    （"expected behaviour on cookie persistence is ambiguous"）。代价是它是**共享**的，
    所以 teardown 必须清干净，否则污染同一 session 里的其它用例。
    """
    res = client.post('/auth/login', json={'username': PYTEST_USERNAME, 'password': PYTEST_PASSWORD})
    assert res.status_code == 200, res.text
    assert client.cookies.get(settings.COOKIE_REFRESH_TOKEN_KEY), 'login 没下发 refresh cookie —— 后面的断言全是假的'

    data = res.json()['data']
    try:
        yield {'Authorization': f'Bearer {data["access_token"]}'}, str(data['session_uuid'])
    finally:
        client.cookies.clear()


def _keep_refresh_cookie(client: TestClient) -> str:
    """把当前 refresh cookie 的值抠出来备用

    🔴 **登出的响应带 `delete_cookie`，httpx 会照办**——直接在登出之后打
    `/auth/refresh`，失败的原因是「压根没带 cookie」，不是「服务端撤销了它」。
    这条断言会**假绿**：把 `revoke_token()` 里删 refresh key 那行注释掉，它照样通过
    （实测确认过）。真实客户端手里那份凭据不会因为服务端说一声就消失
    （桌面端就是自己存在磁盘上的），所以测试必须把它塞回去再验。
    """
    value = client.cookies.get(settings.COOKIE_REFRESH_TOKEN_KEY)
    assert value, '还没登录就取 refresh cookie'
    return value


def _user_id(client: TestClient, headers: dict[str, str]) -> int:
    res = client.get('/sys/users/me', headers=headers)
    assert res.status_code == 200, res.text
    return int(res.json()['data']['id'])


def test_force_offline_also_revokes_the_refresh_token(client: TestClient, session: tuple[dict[str, str], str]) -> None:
    """🔴 回归：强制下线之后，refresh token 必须也失效

    `revoke_token()` 原来只删 access 和附加信息两个 key。而 `create_new_token()`
    只校验「refresh key 存在且值相等」，**从不检查 access key 还在不在** ——
    被踢的会话立刻打一次 `/auth/refresh` 就能换回全新的 access token，
    而此时 `token_keys` 恰好是空的，`multi_login` 那道检查反而更不会拦。
    在线用户页上那一行确实消失了，人却还在。
    """
    headers, session_uuid = session
    user_id = _user_id(client, headers)

    kicked = client.delete(f'/monitors/sessions/{user_id}', params={'session_uuid': session_uuid}, headers=headers)
    assert kicked.status_code == 200, kicked.text

    revived = client.post('/auth/refresh')
    assert revived.status_code != 200, (
        f'强制下线之后还能刷出新 token（HTTP {revived.status_code}）—— refresh key 没被撤销'
    )


def test_logout_revokes_the_refresh_token(client: TestClient, session: tuple[dict[str, str], str]) -> None:
    """登出之后拿同一个 refresh cookie 刷新必须失败"""
    headers, _ = session
    refresh = _keep_refresh_cookie(client)

    assert client.post('/auth/logout', headers=headers).status_code == 200
    # 模拟「客户端手里那份凭据还在」：服务端撤销了才算数
    client.cookies.set(settings.COOKIE_REFRESH_TOKEN_KEY, refresh)
    assert client.post('/auth/refresh').status_code != 200, '登出之后 refresh token 还活着'


def test_logout_works_with_only_the_refresh_cookie(client: TestClient, session: tuple[dict[str, str], str]) -> None:
    """🔴 回归：没有 Authorization 头、只有 refresh cookie 时，登出也必须真的撤销

    这正是桌面端走的路（`apps/desktop/src/main/auth.ts` 的 logout 只手工带 cookie ——
    access token 在渲染层的 sessionStorage 里，主进程手上没有）。
    原来 `logout()` 第一句 `get_token(request)` 拿不到 Bearer 就直接 `return`，
    三个 key 一个没删：桌面端本地删了凭据、界面也回到登录页，而那个会话的
    refresh token 还能再活 7 天。
    """

    refresh = _keep_refresh_cookie(client)

    # 关键：**不带 Authorization**，只有 refresh cookie —— 这就是桌面端发出的那个请求
    assert client.post('/auth/logout').status_code == 200
    client.cookies.set(settings.COOKIE_REFRESH_TOKEN_KEY, refresh)
    assert client.post('/auth/refresh').status_code != 200, '只带 cookie 的登出是空操作，refresh token 还活着'


def test_logout_without_any_credential_is_a_silent_noop(client: TestClient) -> None:
    """两种凭据都没有时，登出要静默成功 —— 它本来就该是幂等的"""
    res = client.post('/auth/logout')
    assert res.status_code == 200, res.text
    assert res.json()['code'] == 200
