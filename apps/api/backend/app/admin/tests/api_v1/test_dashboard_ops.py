"""工作台「系统运行」区的三个接口（#202）：需要你留意 · 服务状态 · 近 N 天访问。

数据是直接往库里垫的（登录日志 / 任务结果 / Webhook 端点），用一个只属于这个文件的标记，前后都**硬删**。
`fba_test` 是 pytest 和 E2E 共用的，表里本来就有别人留下的行 —— 所以计数一律按「垫之前 / 之后的差」断言，
不断言绝对值（tests 分册「别让断言依赖表里现在有多少行」）。
"""

import asyncio

from collections.abc import Generator
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from sqlalchemy import delete, insert, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.testclient import TestClient

from backend.app.admin.model import LoginLog
from backend.app.admin.service.dashboard_service import LOGIN_FAIL_MIN, LOGIN_FAIL_RATIO
from backend.app.task.model import TaskExtended
from backend.core.conf import settings
from backend.utils.timezone import timezone

MARK = 'pytest_dash_ops'
IP = '203.0.113.77'
TASK = 'pytest.dashboard.failing_task'
WEBHOOK_ID = 990000000000000077
APP_ID = 990000000000000001


def _run(*stmts) -> None:
    """独立引擎执行几条语句（同 `temp_user` 的收尾：共享会话绑在 TestClient 的循环上）"""
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def go() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as session:
                for stmt in stmts:
                    await session.execute(stmt)
        finally:
            await engine.dispose()

    asyncio.run(go())


def _purge() -> None:
    from backend.plugin.open.model import OpenApp, OpenWebhook

    _run(
        delete(LoginLog).where(LoginLog.username == MARK),
        delete(TaskExtended).where(TaskExtended.name.like(f'{TASK}%')),
        delete(OpenWebhook).where(OpenWebhook.id == WEBHOOK_ID),
        delete(OpenApp).where(OpenApp.id == APP_ID),
    )


def _open_app() -> None:
    """Webhook 端点挂的应用（「需要你留意」只认没删的应用下的端点）"""
    from backend.plugin.open.model import OpenApp

    _run(
        insert(OpenApp.__table__).values({
            'id': APP_ID,
            'name': 'pytest-ERP',
            'code': 'PYTEST_DASH_ERP',
            'access_key': 'ak_pytest_dash_erp',
            'secret_cipher': 'x',
            'secret_hint': 'x',
            'scopes': '["user:read"]',
            'status': 1,
            'created_time': timezone.now(),
            'deleted': 0,
        })
    )


def _webhook(reason: str, name: str) -> None:
    from backend.plugin.open.model import OpenWebhook

    now = timezone.now()
    _run(
        insert(OpenWebhook.__table__).values({
            'id': WEBHOOK_ID,
            'app_id': APP_ID,
            'name': name,
            'url': 'https://example.com/hook',
            'secret_cipher': 'x',
            'secret_hint': 'x',
            'events': '[]',
            'status': 0,
            'disabled_reason': reason,
            'disabled_time': now,
            'consecutive_failures': 10 if reason == 'auto' else 0,
            'created_time': now,
        })
    )


@pytest.fixture(autouse=True)
def _clean() -> Generator[None, None, None]:
    _purge()
    yield
    _purge()


def _login_rows(at: datetime, *, fails: int = 0, oks: int = 0) -> None:
    rows = [
        {
            'id': 990000000000100000 + i + int(at.timestamp()) % 100000 * 100,
            'user_uuid': MARK,
            'username': MARK,
            'status': 0 if i < fails else 1,
            'ip': IP,
            'msg': 'pytest',
            'login_time': at,
            'created_time': at,
        }
        for i in range(fails + oks)
    ]
    if rows:
        _run(insert(LoginLog.__table__).values(rows))


def _visits(client: TestClient, headers: dict[str, str], **params: object) -> dict[str, dict[str, int]]:
    res = client.get('/sys/dashboard/visits', headers=headers, params={'days': 14, **params})
    assert res.status_code == 200, res.text
    return {p['date']: p for p in res.json()['data']['points']}


@pytest.fixture
def staff_headers(client: TestClient, temp_user: str) -> dict[str, str]:
    """一个普通员工（临时用户，没有日志 / 任务 / Webhook 权限，也不是超管）"""
    res = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': 'Tmp@123456'})
    assert res.status_code == 200, res.text
    body = res.json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


# ── 近 N 天访问 ─────────────────────────────────────────────────────────────


def test_visits_counts_success_and_failure_per_day(client: TestClient, token_headers: dict[str, str]) -> None:
    zone = ZoneInfo('Asia/Shanghai')
    today = datetime.now(zone).replace(hour=10, minute=0, second=0, microsecond=0)
    before = _visits(client, token_headers, tz='Asia/Shanghai')
    assert len(before) == 14
    key = today.date().isoformat()
    assert list(before)[-1] == key, '最后一根柱子要是今天'

    _login_rows(today, fails=3, oks=2)
    after = _visits(client, token_headers, tz='Asia/Shanghai')
    assert after[key]['total'] - before[key]['total'] == 5
    assert after[key]['fails'] - before[key]['fails'] == 3


def test_visits_cuts_days_in_the_viewers_time_zone(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 「哪一天」按查看人的时区切：东八区今天 00:30 在 UTC 还是昨天 —— 按服务端切的话柱子整体错一天"""
    zone = ZoneInfo('Asia/Shanghai')
    early = datetime.now(zone).replace(hour=0, minute=30, second=0, microsecond=0)
    sh_day = early.date().isoformat()
    utc_day = early.astimezone(ZoneInfo('UTC')).date().isoformat()
    assert sh_day != utc_day  # 前提：这一刻在两个时区里确实是不同的两天

    sh_before = _visits(client, token_headers, tz='Asia/Shanghai')
    utc_before = _visits(client, token_headers, tz='UTC')
    _login_rows(early, oks=1)
    sh_after = _visits(client, token_headers, tz='Asia/Shanghai')
    utc_after = _visits(client, token_headers, tz='UTC')
    assert sh_after[sh_day]['total'] - sh_before[sh_day]['total'] == 1
    assert utc_after[utc_day]['total'] - utc_before[utc_day]['total'] == 1


def test_visits_rejects_bad_input_and_needs_login_log_permission(
    client: TestClient, token_headers: dict[str, str], staff_headers: dict[str, str]
) -> None:
    assert client.get('/sys/dashboard/visits', headers=token_headers, params={'tz': 'Mars/Base'}).status_code == 422
    assert client.get('/sys/dashboard/visits', headers=token_headers, params={'days': 0}).status_code == 422
    assert client.get('/sys/dashboard/visits', headers=token_headers, params={'days': 32}).status_code == 422
    assert client.get('/sys/dashboard/visits', headers=staff_headers).status_code == 403


# ── 需要你留意 ───────────────────────────────────────────────────────────────


def _attention(client: TestClient, headers: dict[str, str], **params: object) -> list[dict]:
    res = client.get('/sys/dashboard/attention', headers=headers, params=params)
    assert res.status_code == 200, res.text
    return res.json()['data']


def test_attention_lists_what_needs_a_human(
    client: TestClient, token_headers: dict[str, str], staff_headers: dict[str, str]
) -> None:

    now = timezone.now()
    # 定时任务最近失败了两次（最后一行报错是要显示的那句）
    _run(
        insert(TaskExtended.__table__).values([
            {
                'task_id': f'{MARK}-{i}',
                'name': TASK,
                'status': 'FAILURE',
                'date_done': now - timedelta(hours=i + 1),
                'traceback': 'Traceback (most recent call last):\n  File "x.py"\nTimeoutError: 存储连接超时',
            }
            for i in range(2)
        ])
    )
    # 一个被自动停用的 Webhook 端点（手动停用的不提醒，见下一条）
    _open_app()
    _webhook('auto', 'pytest-ERP 同步')
    # 今天的登录失败要明显高于近 7 天日均：按库里现有的数现算要垫多少（表里有别的用例留下的失败）
    week = _visits(client, token_headers, days=8)
    days = list(week.values())
    today_fails, week_fails = days[-1]['fails'], sum(d['fails'] for d in days[:-1])
    need = max(LOGIN_FAIL_MIN, int(LOGIN_FAIL_RATIO * week_fails / 7) + 1) - today_fails
    # 至少比今天已有的失败**总数**还多一条：库里可能已经有别的 IP 今天失败了好几次，只垫「刚好够」的话
    # 失败最多的那个 IP 就不一定是这里的（开着截图数据的私有库上实测撞过）
    _login_rows(now, fails=max(need, today_fails, 1) + 1)

    items = _attention(client, token_headers)
    task = next(i for i in items if i['kind'] == 'task_failed' and i['task'] == TASK)
    assert task['count'] == 2 and task['error'] == 'TimeoutError: 存储连接超时'
    hook = next(i for i in items if i['kind'] == 'webhook_disabled' and i['name'] == 'pytest-ERP 同步')
    assert hook['level'] == 'critical' and hook['app_id'] == str(APP_ID)
    spike = next(i for i in items if i['kind'] == 'login_fail_spike')
    assert spike['count'] >= LOGIN_FAIL_MIN
    assert spike['top_ip'] == IP

    # 🔴 没有那几个权限的人一条都看不到（上面先断言了「有」，这里的空列表才说明是过滤掉的）
    assert _attention(client, staff_headers) == []


def test_manually_disabled_webhook_is_not_flagged(client: TestClient, token_headers: dict[str, str]) -> None:
    _open_app()
    _webhook('manual', 'pytest-手动停用')
    assert not any(i.get('name') == 'pytest-手动停用' for i in _attention(client, token_headers))


def test_webhook_of_a_deleted_app_is_not_flagged(client: TestClient, token_headers: dict[str, str]) -> None:
    """🔴 应用删了（逻辑删除），它下面自动停用的端点还在表里：再提醒就是一条永远清不掉、点进去 404 的「严重」"""
    from backend.plugin.open.model import OpenApp

    _open_app()
    _webhook('auto', 'pytest-删了应用')
    assert any(i.get('name') == 'pytest-删了应用' for i in _attention(client, token_headers))  # 前提：没删时是提醒的
    _run(update(OpenApp).where(OpenApp.id == APP_ID).values(deleted=APP_ID))
    assert not any(i.get('name') == 'pytest-删了应用' for i in _attention(client, token_headers))


def test_failed_tasks_take_the_newest_traceback_in_one_query(
    client: TestClient, token_headers: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """每个任务最近一次失败的报错，一条查询拿全（原来逐个任务查一次，N+1）"""
    now = timezone.now()
    rows = []
    for t in range(3):
        for i, (hours, line) in enumerate(((1, 'NewestError: 最新'), (5, 'OldError: 旧的'))):
            rows.append({
                'task_id': f'{MARK}-{t}-{i}',
                'name': f'{TASK}.{t}',
                'status': 'FAILURE',
                'date_done': now - timedelta(hours=hours),
                'traceback': f'Traceback (most recent call last):\n{line}',
            })
    # 最新的那条先插（id 更小）：按 id 取「最后一条」的写法会拿到旧的
    _run(insert(TaskExtended.__table__).values(rows))

    seen: list[str] = []
    real_execute, real_scalar = AsyncSession.execute, AsyncSession.scalar

    async def execute(self, statement, *args, **kwargs):
        seen.append(str(statement))
        return await real_execute(self, statement, *args, **kwargs)

    async def scalar(self, statement, *args, **kwargs):
        seen.append(str(statement))
        return await real_scalar(self, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, 'execute', execute)
    monkeypatch.setattr(AsyncSession, 'scalar', scalar)
    items = [i for i in _attention(client, token_headers) if i['kind'] == 'task_failed' and i['task'].startswith(TASK)]
    monkeypatch.undo()

    assert {i['task'] for i in items} == {f'{TASK}.{t}' for t in range(3)}
    assert all(i['count'] == 2 and i['error'] == 'NewestError: 最新' for i in items)
    # 碰任务结果表的查询：一条按任务合并 + 一条取每个任务最近一次的报错，和任务个数无关
    assert sum('task_result' in q for q in seen) == 2, seen


def test_login_fail_spike_counts_today_in_the_viewers_time_zone(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """🔴 「今天」按查看人的时区切（同柱状图）：按服务端时区算的话，同一屏上的柱子和这一条说的不是同一天"""
    server_day = datetime.now(timezone.tz_info).date()
    # 东十四区和西十二区差 26 小时，总有一个和服务端不是同一天
    tz = next(z for z in ('Etc/GMT-14', 'Etc/GMT+12') if datetime.now(ZoneInfo(z)).date() != server_day)
    now = datetime.now(ZoneInfo(tz))
    week = _visits(client, token_headers, days=8, tz=tz)
    days = list(week.values())
    today_fails, week_fails = days[-1]['fails'], sum(d['fails'] for d in days[:-1])
    need = max(LOGIN_FAIL_MIN, int(LOGIN_FAIL_RATIO * week_fails / 7) + 1) - today_fails
    _login_rows(now, fails=max(need, 1) + 1)

    spike = next(i for i in _attention(client, token_headers, tz=tz) if i['kind'] == 'login_fail_spike')
    day = now.date().isoformat()
    assert spike['day'] == day
    assert spike['count'] == _visits(client, token_headers, tz=tz)[day]['fails']
    assert client.get('/sys/dashboard/attention', headers=token_headers, params={'tz': 'Mars/Base'}).status_code == 422


def test_attention_permissions_go_through_user_has_perm(
    client: TestClient,
    token_headers: dict[str, str],
    staff_headers: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """权限判据和接口守卫同一份（`rbac.user_has_perm`）：权限码白名单里的码对所有有菜单的人放行 ——
    自己收集权限码的写法看不到它（casbin 模式下也对不上）"""
    week = _visits(client, token_headers, days=8)
    days = list(week.values())
    today_fails, week_fails = days[-1]['fails'], sum(d['fails'] for d in days[:-1])
    need = max(LOGIN_FAIL_MIN, int(LOGIN_FAIL_RATIO * week_fails / 7) + 1) - today_fails
    _login_rows(timezone.now(), fails=max(need, 1) + 1)
    assert not any(i['kind'] == 'login_fail_spike' for i in _attention(client, staff_headers))  # 前提：员工本来看不到

    monkeypatch.setattr(settings, 'RBAC_ROLE_MENU_EXCLUDE', [*settings.RBAC_ROLE_MENU_EXCLUDE, 'log:login:list'])
    assert any(i['kind'] == 'login_fail_spike' for i in _attention(client, staff_headers))


# ── 服务状态 ─────────────────────────────────────────────────────────────────


def test_services_reports_each_service_and_sessions_by_client(
    client: TestClient, token_headers: dict[str, str], staff_headers: dict[str, str]
) -> None:
    res = client.get('/sys/dashboard/services', headers=token_headers)
    assert res.status_code == 200, res.text
    data = res.json()['data']
    assert set(data['services']) == {'api', 'database', 'redis', 'scheduler', 'worker'}
    assert data['services']['database']['status'] == 'ok'
    assert data['services']['redis']['status'] == 'ok'
    sessions = data['sessions']
    assert set(sessions) == {'total', 'web', 'desktop', 'mobile'}
    assert sessions['total'] == sessions['web'] + sessions['desktop'] + sessions['mobile']
    # 和在线用户页同一个口径：swagger 调试口的会话不算 —— 这条用例自己就拿着一个（`token_headers` 走的是 swagger 口），
    # 算进去的话这里会比在线用户页多一个
    online = client.get('/monitors/sessions', headers=token_headers).json()['data']
    assert sessions['total'] == len(online)
    # 超管专属（在线会话和在线用户页同一个门槛）
    assert client.get('/sys/dashboard/services', headers=staff_headers).status_code == 403
