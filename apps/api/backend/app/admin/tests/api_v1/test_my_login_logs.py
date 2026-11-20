"""个人中心「最近登录」（#405）：`GET /sys/users/me/login-logs`。

原来前端借的是 `GET /logs/login?username=…`，那条 #30 起要 `log:login:list` —— 没这个权限码的人
打开「个人中心 → 安全」恒显示「登录记录读取失败」，而这块本来就是让**每个人**自查账号有没有被盗用的。

用种子里的 `test`（STAFF，只看仪表盘、没有日志权限码，还开着数据范围过滤）做主角。
🔴 造登录记录要走真 `/auth/login`：swagger 调试口不写登录日志（见 `test_login_events.py`）。
"""

import asyncio

from collections.abc import Iterator

import pytest
import sqlalchemy as sa

from starlette.testclient import TestClient

from backend.app.admin.model import LoginLog
from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.redis import RedisCli
from backend.tests.utils.db import sync_test_db_url
from backend.utils.timezone import timezone

STAFF = 'test'
PASSWORD = '123456'


async def _flush_counters() -> None:
    client = RedisCli()
    try:
        prefixes = (settings.LOGIN_FAILURE_PREFIX, settings.USER_LOCK_REDIS_PREFIX, settings.LOGIN_IP_FAILURE_PREFIX)
        for prefix in prefixes:
            keys = await client.keys(f'{prefix}*')
            if keys:
                await client.delete(*keys)
    finally:
        await client.aclose()


@pytest.fixture(autouse=True)
def _clean() -> Iterator[None]:
    """本条造的失败尝试会累加失败计数；写进登录日志的行收尾删掉"""
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


@pytest.fixture
def staff(client: TestClient, no_captcha: None) -> Iterator[dict[str, str]]:
    """`test` 真登录一次（顺带往登录日志里写一行成功），收尾撤销它的会话"""
    res = client.post('/auth/login', json={'username': STAFF, 'password': PASSWORD})
    assert res.status_code == 200 and res.json()['code'] == 200, res.text
    client.cookies.clear()
    data = res.json()['data']
    yield {'Authorization': f'Bearer {data["access_token"]}'}
    client.portal.call(session_store.revoke_user, int(data['user']['id']), EndReason.logout)


def test_a_user_without_the_log_code_reads_their_own_logins(client: TestClient, staff: dict[str, str]) -> None:
    # 前置：这个人确实读不了审计视图 —— 否则下面的 200 证明不了什么
    assert client.get('/logs/login', headers=staff).status_code == 403

    # 一次失败尝试也得在：这块最要紧的就是「有人在试你的密码」
    client.post('/auth/login', json={'username': STAFF, 'password': 'wrong-password'})
    client.cookies.clear()

    res = client.get('/sys/users/me/login-logs', headers=staff)
    assert res.status_code == 200 and res.json()['code'] == 200, res.text
    rows = res.json()['data']
    assert rows, '先断言「有」：刚登录过，至少有那一行'
    assert {r['username'] for r in rows} == {STAFF}
    # 🔴 密码错的那次记的是随机 uuid —— 按 uuid 查的第一版就是在这里红的
    assert {r['status'] for r in rows[:2]} == {0, 1}, '最近的两条就是刚才那次成功和那次失败'
    times = [r['login_time'] for r in rows]
    assert times == sorted(times, reverse=True), '新的在前'


def test_only_your_own_rows_come_back(client: TestClient, token_headers: dict[str, str], staff: dict[str, str]) -> None:
    """原来按 `username LIKE '%test%'` 取，再在前端全等筛一遍；现在后端全等，前缀相同的别人一条也不进来"""
    engine = sa.create_engine(sync_test_db_url())
    try:
        with engine.begin() as conn:
            # 用户名以 `test` 开头、uuid 不同：LIKE 会把它捞回来
            conn.execute(
                sa.insert(LoginLog.__table__).values(
                    id=8_405_000_000_000_000_001,  # 收尾按 created_time 删，id 只要不撞
                    user_uuid='someone-else',
                    username=f'{STAFF}2',
                    status=1,
                    ip='10.0.0.9',
                    msg='pytest',
                    login_time=timezone.now(),
                    event='login',
                    created_time=timezone.now(),
                )
            )
    finally:
        engine.dispose()

    rows = client.get('/sys/users/me/login-logs', headers=staff, params={'limit': 50}).json()['data']
    assert rows and all(r['username'] == STAFF for r in rows)
    # 超管读自己的也只是自己的
    admin_rows = client.get('/sys/users/me/login-logs', headers=token_headers, params={'limit': 50}).json()['data']
    assert all(r['username'] == 'admin' for r in admin_rows)


def test_limit_is_bounded(client: TestClient, staff: dict[str, str]) -> None:
    assert len(client.get('/sys/users/me/login-logs', headers=staff, params={'limit': 1}).json()['data']) == 1
    assert client.get('/sys/users/me/login-logs', headers=staff, params={'limit': 51}).status_code == 422
