"""登录会话（#138）的守卫测试。

#138 之前实测出来的六个问题（T1–T6，issue 正文有原始输出）每个一条回归，外加新模型自己的规则：
宽限期回放 / 盗用撤销 / 空闲按人算 / 会话上限 / 按端计数 / 每个撤销入口都带原因码。

造场景（空闲、到期、宽限期已过）一律**直接改 Redis 里的会话字段**，不 sleep：
经 `client.portal` 在应用自己的事件循环里调，复用全局 `redis_client`（同 `test_export.py`）。

⚠️ 用 `temp_user` 建的临时账号，不碰 admin —— admin 是全套测试共用的登录身份，
在它身上测「挤人 / 停用 / 改密码」会把别的用例的会话一起带走。
"""

import secrets
import time

from collections.abc import Iterator
from dataclasses import dataclass

import pytest

from httpx import Response
from starlette.testclient import TestClient

from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.redis import redis_client

USERNAME = 'pytest_tmp_writes'
PASSWORD = 'Tmp@123456'
KEY = settings.COOKIE_REFRESH_TOKEN_KEY


@dataclass
class Login:
    headers: dict[str, str]
    sid: str
    refresh: str


def _issued_refresh(res: Response) -> str | None:
    """响应里真正下发的那个 refresh cookie（跳过清旧 cookie 的那一行，它的值是空串）"""
    for line in res.headers.get_list('set-cookie'):
        name, _, rest = line.partition('=')
        value = rest.split(';', 1)[0]
        if name == KEY and value not in ('', '""'):
            return value
    return None


def _login(client: TestClient, kind: str = 'web', *, keep_cookie: bool = False) -> Login:
    res = client.post('/auth/login', json={'username': USERNAME, 'password': PASSWORD, 'client': kind})
    assert res.status_code == 200, res.text
    if not keep_cookie:
        client.cookies.clear()
    data = res.json()['data']
    refresh = _issued_refresh(res)
    assert refresh, 'login 没下发 refresh cookie —— 后面的断言全是假的'
    return Login({'Authorization': f'Bearer {data["access_token"]}'}, data['session_uuid'], refresh)


def _refresh(client: TestClient, refresh: str) -> Response:
    client.cookies.set(KEY, refresh)
    try:
        return client.post('/auth/refresh')
    finally:
        client.cookies.clear()


def _me(client: TestClient, login: Login, **headers: str) -> Response:
    return client.get('/sys/users/me', headers={**login.headers, **headers})


def _reason(res: Response) -> str | None:
    return (res.json().get('data') or {}).get('reason')


def _session(client: TestClient, sid: str) -> dict[str, str]:
    return client.portal.call(redis_client.hgetall, f'{settings.SESSION_REDIS_PREFIX}:{sid}')


def _patch(client: TestClient, sid: str, **fields: int) -> None:
    async def _do() -> None:
        await redis_client.hset(f'{settings.SESSION_REDIS_PREFIX}:{sid}', mapping=fields)
        if 'last_active' in fields:
            # 挑「最久没活跃」靠的是索引里的分值，hash 和索引要一起改
            uid = await redis_client.hget(f'{settings.SESSION_REDIS_PREFIX}:{sid}', 'uid')
            await redis_client.zadd(f'{settings.SESSION_USER_INDEX_PREFIX}:{uid}', {sid: fields['last_active']})

    client.portal.call(_do)


@pytest.fixture
def account(client: TestClient, temp_user: str, no_captcha: None) -> Iterator[int]:
    """临时账号；收尾时把它的会话全撤掉（账号本身由 `temp_user` 硬删）"""
    yield int(temp_user)
    client.portal.call(session_store.revoke_user, int(temp_user), EndReason.disabled)


@pytest.fixture
def policy(monkeypatch: pytest.MonkeyPatch) -> Iterator[object]:
    """改会话策略：顶掉登录时从 sys_config 加载的那一份，否则它会把这里设的值盖回去"""

    async def _noop(_db: object) -> None:  # ruff: ignore[unused-async] - 顶掉的原函数是 async
        return None

    monkeypatch.setattr('backend.app.admin.service.auth_service.load_session_config', _noop)

    def _set(**values: object) -> None:
        for key, value in values.items():
            monkeypatch.setattr(settings, key, value)

    return _set


# ─── T1 / T4：会话 ID 稳定，宽限期回放，期外判盗用 ───────────────────────────────


def test_refresh_keeps_the_session_id_and_rotates_the_secret(client: TestClient, account: int) -> None:
    """T1 回归：#138 之前每刷新一次 session_uuid 就换一个，在线用户页每天换一批 ID、审计跟不住一次登录"""
    a = _login(client)
    res = _refresh(client, a.refresh)
    assert res.status_code == 200, res.text
    assert res.json()['data']['session_uuid'] == a.sid
    rotated = _issued_refresh(res)
    assert rotated and rotated != a.refresh
    assert rotated.split('.')[0] == a.sid
    # 刷新不作废上一枚 access token：同一个会话里几个标签页各拿一枚，谁也不该把别人顶掉
    assert _me(client, a).status_code == 200


def test_previous_token_within_grace_replays_the_same_pair(client: TestClient, account: int) -> None:
    """T4 回归：#138 之前同一枚 refresh token 并发刷两次，一个 200、一个 401 —— 多标签页同时刷新时输的那个被登出"""
    a = _login(client)
    first = _refresh(client, a.refresh)
    again = _refresh(client, a.refresh)
    assert (first.status_code, again.status_code) == (200, 200), again.text
    # 宽限期内的重复出示必须拿到同一个新令牌，否则两边又互相作废
    assert _issued_refresh(again) == _issued_refresh(first)


def test_previous_token_after_grace_revokes_the_whole_session(client: TestClient, account: int) -> None:
    """宽限期外又出示上一代 = 凭据可能被盗：整个会话撤销，连当前那一代也不能再用"""
    a = _login(client)
    current = _issued_refresh(_refresh(client, a.refresh))
    _patch(client, a.sid, rotated_at=int(time.time()) - settings.SESSION_REFRESH_GRACE_SECONDS - 5)

    stale = _refresh(client, a.refresh)
    assert stale.status_code == 401
    assert _reason(stale) == EndReason.reuse
    assert _reason(_refresh(client, current)) == EndReason.reuse
    assert _reason(_me(client, a)) == EndReason.reuse


def test_unknown_secret_with_a_real_session_id_does_not_revoke(client: TestClient, account: int) -> None:
    """会话 ID 写在 cookie 里、日志里都看得见 —— 凭它就能把人踢下线是送上门的 DoS"""
    a = _login(client)
    forged = f'{a.sid}.{secrets.token_urlsafe(32)}'
    assert _refresh(client, forged).status_code == 401
    assert _refresh(client, a.refresh).status_code == 200, '一枚伪造的 secret 把真会话撤掉了'


def test_pre_138_refresh_token_is_a_clean_401(client: TestClient) -> None:
    """升级那一刻浏览器里还是旧格式（JWT）的 cookie：要干净地 401 让人重新登录，不能 500"""
    res = _refresh(client, 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl')
    assert res.status_code == 401
    assert _reason(res) == EndReason.expired


# ─── T5：绝对有效期 + 空闲按「人有没有在操作」算 ─────────────────────────────────


def test_refresh_does_not_extend_the_absolute_lifetime(client: TestClient, account: int) -> None:
    """T5 回归：#138 之前每次刷新都把 refresh 重置成 7 天，每周用一次就永远不用重新登录"""
    a = _login(client)
    expire_at = int(_session(client, a.sid)['expire_at'])
    assert _refresh(client, a.refresh).status_code == 200
    assert int(_session(client, a.sid)['expire_at']) == expire_at


def test_past_absolute_lifetime_ends_the_session(client: TestClient, account: int) -> None:
    a = _login(client)
    _patch(client, a.sid, expire_at=int(time.time()) - 1)
    res = _me(client, a)
    assert res.status_code == 401
    assert _reason(res) == EndReason.expired


def test_idle_session_ends_with_reason_idle(client: TestClient, account: int) -> None:
    a = _login(client)
    idle = int(_session(client, a.sid)['idle'])
    _patch(client, a.sid, last_active=int(time.time()) - idle - 5)
    # 带着「没操作」的头来：这是一次后台轮询
    res = _me(client, a, **{'X-Client-Idle': str(idle + 5)})
    assert res.status_code == 401
    assert _reason(res) == EndReason.idle
    assert _reason(_refresh(client, a.refresh)) == EndReason.idle


def test_background_polling_does_not_keep_the_session_alive(client: TestClient, account: int) -> None:
    """🔴 空闲不能按请求算：在线用户页 10 秒轮询一次，按请求算的话人走开了会话也永远不过期"""
    a = _login(client)
    before = int(time.time()) - 120
    _patch(client, a.sid, last_active=before)
    # 先断言「有」：这一枚 token 是能用的，下面「没续上」才有意义
    assert _me(client, a, **{'X-Client-Idle': '3600'}).status_code == 200
    assert int(_session(client, a.sid)['last_active']) == before, '后台轮询把最后活跃时间续上了'


def test_user_activity_moves_last_active_forward(client: TestClient, account: int) -> None:
    """反方向：真有操作的请求要续上，否则上一条把「从不续」的实现也放过去了"""
    a = _login(client)
    before = int(time.time()) - 600
    _patch(client, a.sid, last_active=before)
    assert _me(client, a, **{'X-Client-Idle': '0'}).status_code == 200
    assert int(_session(client, a.sid)['last_active']) >= int(time.time()) - 5


def test_clients_without_the_idle_header_count_as_active(client: TestClient, account: int) -> None:
    """移动端 / 桌面主进程不带这个头：按刚操作过算，不然它们一律被判空闲"""
    a = _login(client)
    _patch(client, a.sid, last_active=int(time.time()) - 600)
    assert _me(client, a).status_code == 200
    assert int(_session(client, a.sid)['last_active']) >= int(time.time()) - 5


# ─── 会话上限 + 按端计数 ─────────────────────────────────────────────────────


def test_overflow_evicts_the_least_recently_active(client: TestClient, account: int, policy: object) -> None:
    """挤掉的是最久没活跃的那个，不是最早登录的 —— 天天在用的那台不该先被踢"""
    policy(SESSION_WEB_MAX=2, SESSION_WEB_OVERFLOW='evict_idle')  # type: ignore[operator]
    first = _login(client)
    second = _login(client)
    # 第一个更早登录，但第二个更久没动过
    _patch(client, first.sid, last_active=int(time.time()) - 10)
    _patch(client, second.sid, last_active=int(time.time()) - 1000)

    _login(client)
    assert _me(client, first).status_code == 200, '挤掉的是最早登录的那个，而它是最近在用的'
    evicted = _me(client, second)
    assert evicted.status_code == 401
    assert _reason(evicted) == EndReason.replaced


def test_overflow_deny_rejects_the_new_login(client: TestClient, account: int, policy: object) -> None:
    policy(SESSION_WEB_MAX=1, SESSION_WEB_OVERFLOW='deny')  # type: ignore[operator]
    first = _login(client)
    res = client.post('/auth/login', json={'username': USERNAME, 'password': PASSWORD})
    client.cookies.clear()
    assert res.status_code == 403, res.text
    assert '上限' in res.json()['msg']
    assert _me(client, first).status_code == 200, '拒绝新登录却把旧会话撤了'


def test_each_client_has_its_own_limit(client: TestClient, account: int, policy: object) -> None:
    """手机和电脑同时在线：上限按端算，不是按人算"""
    policy(SESSION_WEB_MAX=1, SESSION_MOBILE_MAX=1)  # type: ignore[operator]
    web = _login(client, 'web')
    mobile = _login(client, 'mobile')
    assert _me(client, web).status_code == 200
    assert _me(client, mobile).status_code == 200
    assert _session(client, mobile.sid)['client'] == 'mobile'


def test_relogin_in_the_same_browser_replaces_the_previous_session(client: TestClient, account: int) -> None:
    """同一个浏览器再登一次：上一个会话就地作废，不留一个没人用、却占着上限名额的会话"""
    first = _login(client, keep_cookie=True)
    _login(client)
    res = _me(client, first)
    assert res.status_code == 401
    assert _reason(res) == EndReason.replaced


# ─── T2 / T3：在线用户页 · 每个撤销入口都带原因 ─────────────────────────────────


def _online(client: TestClient, headers: dict[str, str]) -> list[dict]:
    res = client.get('/monitors/sessions', headers=headers)
    assert res.status_code == 200, res.text
    return res.json()['data']


def test_online_list_reads_the_session_index(client: TestClient, token_headers: dict[str, str], account: int) -> None:
    """T2 回归：#138 之前列表扫的是 access token 的 key，access 过期、refresh 还活着的会话看不见也踢不掉"""
    a = _login(client, 'mobile')
    rows = {row['session_uuid']: row for row in _online(client, token_headers)}
    assert a.sid in rows
    assert rows[a.sid]['client'] == 'mobile'
    # swagger 调试口的会话不进列表（token_headers 自己就是一个）
    assert all(row['client'] != 'swagger' for row in rows.values())

    # 空闲过了的会话不算在线 —— 它的 key 还留着，只是为了报出「因为空闲」
    _patch(client, a.sid, last_active=int(time.time()) - int(_session(client, a.sid)['idle']) - 5)
    assert a.sid not in {row['session_uuid'] for row in _online(client, token_headers)}


def test_kick_tells_the_user_why(client: TestClient, token_headers: dict[str, str], account: int) -> None:
    """T3 回归：#138 之前被踢 / 被顶的人只看到「莫名其妙又要登录」，原因在前端被丢掉了"""
    a = _login(client)
    res = client.delete(f'/monitors/sessions/{account}', params={'session_uuid': a.sid}, headers=token_headers)
    assert res.status_code == 200, res.text
    me = _me(client, a)
    assert me.status_code == 401
    assert _reason(me) == EndReason.kicked
    assert '管理员' in me.json()['msg']
    assert _reason(_refresh(client, a.refresh)) == EndReason.kicked


def test_kick_with_a_mismatched_user_id_is_rejected(
    client: TestClient, token_headers: dict[str, str], account: int
) -> None:
    a = _login(client)
    res = client.delete('/monitors/sessions/1', params={'session_uuid': a.sid}, headers=token_headers)
    assert res.status_code == 404
    assert _me(client, a).status_code == 200


def test_password_reset_ends_every_session(client: TestClient, token_headers: dict[str, str], account: int) -> None:
    a, b = _login(client), _login(client, 'mobile')
    res = client.put(f'/sys/users/{account}/password', headers=token_headers, json={'password': 'Rs1@abcdefg'})
    assert res.status_code == 200, res.text
    for login in (a, b):
        me = _me(client, login)
        assert (me.status_code, _reason(me)) == (401, EndReason.password_changed)


def test_disabling_a_user_ends_every_session(client: TestClient, token_headers: dict[str, str], account: int) -> None:
    a = _login(client)
    res = client.put(f'/sys/users/{account}/permissions', headers=token_headers, params={'type': 'status'})
    assert res.status_code == 200, res.text
    assert _reason(_refresh(client, a.refresh)) == EndReason.disabled
    # 还原，让 temp_user 的收尾照常走
    client.put(f'/sys/users/{account}/permissions', headers=token_headers, params={'type': 'status'})


def test_logout_with_a_forged_secret_does_not_revoke(client: TestClient, account: int) -> None:
    """只带 cookie 的登出（桌面端）要 secret 对得上才算数"""
    a = _login(client)
    client.cookies.set(KEY, f'{a.sid}.{secrets.token_urlsafe(32)}')
    try:
        assert client.post('/auth/logout').status_code == 200
    finally:
        client.cookies.clear()
    assert _me(client, a).status_code == 200


def test_logout_reason_reaches_the_other_tabs(client: TestClient, account: int) -> None:
    """同一个浏览器的标签页共用一个会话：一个标签页登出，其它标签页拿着自己那枚 access token 也该知道为什么"""
    a = _login(client)
    assert client.post('/auth/logout', headers=a.headers).status_code == 200
    me = _me(client, a)
    assert (me.status_code, _reason(me)) == (401, EndReason.logout)


# ─── T6：cookie 属性 · 401 的原因码在 prod 也要下发 ─────────────────────────────


def test_refresh_cookie_attributes(client: TestClient, account: int) -> None:
    """T6 回归：#138 之前是 `Path=/`、没有 `Secure`"""
    res = client.post('https://testserver/api/v1/auth/login', json={'username': USERNAME, 'password': PASSWORD})
    client.cookies.clear()
    assert res.status_code == 200, res.text
    lines = [line for line in res.headers.get_list('set-cookie') if line.startswith(f'{KEY}=')]
    issued = lines[0].lower()
    assert f'path={settings.COOKIE_REFRESH_TOKEN_PATH}'.lower() in issued
    assert 'httponly' in issued
    assert 'secure' in issued, 'HTTPS 请求下发的 refresh cookie 没有 Secure'
    assert 'samesite=lax' in issued
    # 🔴 清旧 cookie（Path=/）那一行必须排在后面：桌面端主进程按名字取第一个 Set-Cookie。
    # 这一行还守着操作日志中间件：它重建响应时曾用 dict 搬头，第二行 Set-Cookie 被静默吞掉
    assert len(lines) == 2, f'清旧 cookie 那一行没了：{lines}'
    assert 'path=/;' in lines[1].lower() or lines[1].lower().endswith('path=/')
    assert 'max-age=0' in lines[1].lower()


def test_plain_http_does_not_get_a_secure_cookie(client: TestClient, account: int) -> None:
    """反方向：没上 HTTPS 的部署浏览器不存 Secure cookie，一律带上的话每 30 分钟被登出一次"""
    res = client.post('/auth/login', json={'username': USERNAME, 'password': PASSWORD})
    client.cookies.clear()
    issued = next(line for line in res.headers.get_list('set-cookie') if line.startswith(f'{KEY}=')).lower()
    assert 'secure' not in issued


def test_session_end_reason_survives_the_prod_exception_handler(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """prod 下 HTTP 异常会被换成一句通用的「请求错误」—— 401 不能走那条，否则前端拿不到原因码"""
    monkeypatch.setattr(settings, 'ENVIRONMENT', 'prod')
    res = _refresh(client, 'not-a-token')
    assert res.status_code == 401
    assert _reason(res) == EndReason.expired
    assert res.json()['msg'] != '请求错误'


# ─── socket：会话 ID 从令牌里取 ──────────────────────────────────────────────────


def test_socket_presence_uses_the_session_from_the_token(client: TestClient, account: int) -> None:
    """#138 之前用的是前端报上来的 `session_uuid`：刷新后前端那份是旧的（那时每次刷新都换 ID），
    在线用户页把正连着的会话显示成离线；而且报一个别人的会话 ID 就能把它标成在线"""
    from backend.common.socketio.server import connect, disconnect

    a = _login(client)
    socket_id = f'pytest-{secrets.token_hex(4)}'
    try:
        accepted = client.portal.call(
            connect, socket_id, {}, {'token': a.headers['Authorization'][7:], 'session_uuid': 'forged'}
        )
        assert accepted is True
        bound = client.portal.call(redis_client.get, f'{settings.TOKEN_ONLINE_REDIS_PREFIX}:sid:{socket_id}')
        assert bound == a.sid
    finally:
        client.portal.call(disconnect, socket_id)
