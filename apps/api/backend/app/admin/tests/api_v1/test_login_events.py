"""登录日志里的安全事件（#273）：账号被锁 · IP 被锁 · 被强制下线。

断言一律经接口读回（`GET /logs/login?event=…`）—— 筛选参数三层对齐那条在 AI 插件的测试里，
这里顺带也验了「接口真的认这个参数」。

⚠️ 和 `test_auth.py` 一样，前后清掉失败计数 / 锁定标记：本模块故意制造失败登录
"""

import asyncio

from collections.abc import Iterator
from typing import Any

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.app.admin.model import LoginLog
from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.redis import RedisCli, redis_client
from backend.tests.utils.db import sync_test_db_url
from backend.utils.timezone import timezone

USERNAME = 'pytest_tmp_writes'
PASSWORD = 'Tmp@123456'


async def _flush_counters() -> None:
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


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    """失败计数清掉；这条测试写进登录日志的行收尾删掉（别的测试按条数断言时不被它们干扰）"""
    started = timezone.now()
    asyncio.run(_flush_counters())
    yield
    asyncio.run(_flush_counters())
    engine = sa.create_engine(sync_test_db_url())
    try:
        with engine.begin() as conn:
            conn.execute(sa.delete(LoginLog.__table__).where(LoginLog.created_time >= started))
    finally:
        engine.dispose()


def _swagger_login(client: TestClient, username: str, password: str) -> Any:
    return client.post('/auth/login/swagger', params={'username': username, 'password': password})


@pytest.fixture
def since() -> dict[str, str]:
    """只看这条测试开始之后的行：同一轮里别的测试收尾时会撤销同一个临时账号的会话（`EndReason.disabled`），
    那本身就会记成「被强制下线」。精确到微秒 —— 按秒截的话，上一条测试的收尾落在同一秒里就混进来"""
    return {'start_time': timezone.now().isoformat()}


def _rows(client: TestClient, headers: dict[str, str], **params: Any) -> list[dict[str, Any]]:
    res = client.get('/logs/login', headers=headers, params={'size': 100, **params}).json()
    assert res['code'] == 200, res
    return res['data']['items']


def _login_attempt(client: TestClient, password: str) -> Any:
    """🔴 走真登录接口：swagger 调试口**不写登录日志**，用它的话「失败尝试照记」那句断言验不到东西"""
    res = client.post('/auth/login', json={'username': USERNAME, 'password': password})
    client.cookies.clear()
    return res


def test_an_account_lock_is_one_event_row(
    client: TestClient, token_headers: dict[str, str], temp_user: str, no_captcha: None, since: dict[str, str]
) -> None:
    for _ in range(settings.USER_LOCK_THRESHOLD):
        _login_attempt(client, 'wrong-password')
    # 先断言「真的锁了」：不然下面「只有一行」在什么都没发生时也成立
    assert _login_attempt(client, PASSWORD).json()['code'] != 200
    (locked,) = _rows(client, token_headers, username=USERNAME, event='locked', **since)
    assert locked['status'] == 0 and '锁定' in locked['msg'] and str(settings.USER_LOCK_THRESHOLD) in locked['msg']
    # 锁住之后再试：不再累加、也不再记新的锁定行（不然攻击者能刷屏）
    _login_attempt(client, 'wrong-password')
    assert len(_rows(client, token_headers, username=USERNAME, event='locked', **since)) == 1
    # 原来的失败尝试照记，事件归「登录」：5 次错密码 + 锁住后对的密码 + 锁住后又错一次
    attempts = _rows(client, token_headers, username=USERNAME, event='login', **since)
    assert len(attempts) == settings.USER_LOCK_THRESHOLD + 2
    assert all(r['status'] == 0 for r in attempts)


def test_an_ip_lock_is_recorded_though_the_client_cannot_tell(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch, since: dict[str, str]
) -> None:
    """对方看到的仍是「用户名或密码有误」（不给攻击者反馈），只有登录日志里这一行让管理员知道 IP 被锁了"""
    monkeypatch.setattr(settings, 'LOGIN_IP_LOCK_THRESHOLD', 3)
    replies = [_swagger_login(client, f'pytest-no-such-{i}', 'x').json()['msg'] for i in range(4)]
    assert len(set(replies)) == 1, '被锁之前和之后，对方看到的必须是同一句话'
    (locked,) = _rows(client, token_headers, event='ip_locked', **since)
    # 记的是跨过阈值的那一次试的用户名；锁住之后的第 4 次不再记
    assert locked['username'] == 'pytest-no-such-2'
    assert '3' in locked['msg'] and locked['ip']


def _login(client: TestClient, kind: str = 'web') -> dict[str, Any]:
    res = client.post('/auth/login', json={'username': USERNAME, 'password': PASSWORD, 'client': kind})
    assert res.status_code == 200, res.text
    client.cookies.clear()
    return res.json()['data']


@pytest.fixture
def account(client: TestClient, temp_user: str, no_captcha: None) -> Iterator[int]:
    yield int(temp_user)
    client.portal.call(session_store.revoke_user, int(temp_user), EndReason.logout)


def test_a_kick_records_the_kicked_device_and_who_kicked(
    client: TestClient, token_headers: dict[str, str], account: int, since: dict[str, str]
) -> None:
    """🔴 记的是**被踢的那个会话**的 IP / 浏览器，不是点按钮的管理员的"""
    sid = _login(client)['session_uuid']
    client.portal.call(redis_client.hset, f'{settings.SESSION_REDIS_PREFIX}:{sid}', 'ip', '10.9.8.7')
    res = client.delete(f'/monitors/sessions/{account}', params={'session_uuid': sid}, headers=token_headers)
    assert res.json()['code'] == 200, res.text
    (kicked,) = _rows(client, token_headers, username=USERNAME, event='kicked', **since)
    assert kicked['ip'] == '10.9.8.7'
    assert 'admin' in kicked['msg'] and '强制下线' in kicked['msg']


def test_a_password_reset_records_every_session_it_ended(
    client: TestClient, token_headers: dict[str, str], account: int, since: dict[str, str]
) -> None:
    """改密码 / 停用连带撤销的会话原来什么记录都没有。撤销入口只有 `session_store.revoke` 一个，在那里统一记"""
    _login(client, 'web')
    _login(client, 'mobile')
    res = client.put(f'/sys/users/{account}/password', headers=token_headers, json={'password': 'New@123456'})
    assert res.json()['code'] == 200, res.text
    rows = _rows(client, token_headers, username=USERNAME, event='kicked', **since)
    assert len(rows) == 2
    assert all('admin 改了密码' in r['msg'] for r in rows)


def test_logging_out_yourself_is_not_a_forced_logout(
    client: TestClient, token_headers: dict[str, str], account: int, since: dict[str, str]
) -> None:
    data = _login(client)
    res = client.post('/auth/logout', headers={'Authorization': f'Bearer {data["access_token"]}'})
    assert res.json()['code'] == 200, res.text
    assert client.portal.call(session_store.user_of, data['session_uuid']) is None, '前置：会话确实结束了'
    assert _rows(client, token_headers, username=USERNAME, event='kicked', **since) == []


def test_the_dashboard_counts_only_sign_in_attempts(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 安全事件的状态是失败：不按事件过滤的话，踢一次人工作台上就多一次「登录失败」"""

    def today() -> dict[str, Any]:
        res = client.get('/sys/dashboard/visits', headers=token_headers, params={'days': 1}).json()
        return res['data']['points'][-1]

    before = today()
    engine = sa.create_engine(sync_test_db_url())
    try:
        with engine.begin() as conn:
            conn.execute(
                sa.insert(LoginLog.__table__),
                [
                    {
                        'id': 910000000000003001 + i,
                        'user_uuid': 'pytest-event',
                        'username': 'pytest-event',
                        'status': 0,
                        'ip': '10.0.0.1',
                        'msg': '测试',
                        'login_time': timezone.now(),
                        'created_time': timezone.now(),
                        'event': event,
                    }
                    for i, event in enumerate(('kicked', 'locked', 'ip_locked'))
                ],
            )
        after = today()
    finally:
        engine.dispose()
    assert (after['total'], after['fails']) == (before['total'], before['fails'])
