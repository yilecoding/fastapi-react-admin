"""任务提示：失败真的推得出去 · 只推给能看执行记录的人 · 不带异常原文（#400）

`TaskBase.on_failure` 是 worker 主线程上同步调的，原来 `asyncio.get_running_loop().create_task(...)` 外面
`except RuntimeError: pass` —— 主线程上没有正在跑的循环，每次都被吞掉，失败提示从来没推出去过。
修完之后它投进 AsyncIOPool 自己的循环（`celery.py: pool_loop`）。这里用「独立线程里 run_forever 的循环」
仿那个池，钉住：投得进去 · 内容不带异常原文 · 同一任务 60 秒内只推一次 · 受众按 `task:result:list` 算。
"""

import asyncio
import functools
import threading
import time
import uuid

from collections import UserList
from types import SimpleNamespace

import bcrypt
import celery_aio_pool
import pytest

from sqlalchemy import delete, insert, select

from backend.app.admin.model import Dept, Menu, Role, User, role_menu, user_role
from backend.app.admin.utils.password_security import get_hash_password
from backend.app.task.tasks import base
from backend.app.task.tasks.maintenance.tasks import prune_logs, prune_task_results
from backend.app.task.utils import notify
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.tests.utils.db import async_test_db_session

SECRET = "(psycopg.OperationalError) connection to server at '10.9.8.7', port 5432 failed: password=hunter2"


@pytest.fixture
def pool(monkeypatch):
    """仿 AsyncIOPool 的单例：独立线程里 `run_forever()` 的循环"""
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    monkeypatch.setattr(celery_aio_pool.AsyncIOPool, 'singleton', SimpleNamespace(loop=loop))
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(2)
    loop.close()


class _Sent(UserList):
    """推出去的提示；`wait()` 等第一条到（推送跑在另一个线程的循环上）"""

    def __init__(self) -> None:
        super().__init__()
        self.done = threading.Event()

    def wait(self, timeout: float = 2) -> bool:
        return self.done.wait(timeout)


@pytest.fixture
def pushed(monkeypatch) -> _Sent:
    sent = _Sent()

    async def record(msg: str) -> None:  # ruff: ignore[unused-async] —— 顶替的是协程
        sent.append(msg)
        sent.done.set()

    monkeypatch.setattr(base, 'notify_task_watchers', record)
    monkeypatch.setattr(base, '_last_failure_notified', {})
    return sent


def test_a_failure_is_pushed_from_the_worker_thread(pool, pushed) -> None:
    """🔴 在**没有运行中循环**的线程上调 on_failure（和 worker 主线程一样），提示必须真的推出去"""
    with pytest.raises(RuntimeError):
        asyncio.get_running_loop()  # 前提：这里确实没有正在跑的循环

    prune_logs.on_failure(RuntimeError(SECRET), 'tid-1', (), {}, None)

    assert pushed.wait(), '失败提示没推出去 —— 又被吞了'
    assert len(pushed) == 1
    assert 'maintenance.prune_logs' in pushed[0]
    assert 'tid-1' in pushed[0]


def test_the_failure_push_carries_no_exception_text(pool, pushed) -> None:
    """SQL、主机、密码在执行记录里（要权限才看得到），推送里一个字都不能有"""
    prune_logs.on_failure(RuntimeError(SECRET), 'tid-2', (), {}, None)
    assert pushed.wait()
    for fragment in ('10.9.8.7', 'hunter2', 'OperationalError', 'psycopg'):
        assert fragment not in pushed[0], pushed[0]
    assert '执行记录' in pushed[0]


def test_repeated_failures_of_one_task_are_pushed_once_a_minute(pool, pushed, monkeypatch) -> None:
    """每 15 秒一次的任务连续失败时，同一个任务 60 秒内只推一次；别的任务不受影响"""
    clock = [1000.0]
    monkeypatch.setattr(base.time, 'monotonic', lambda: clock[0])

    prune_logs.on_failure(RuntimeError('x'), 'a', (), {}, None)
    clock[0] += 15
    prune_logs.on_failure(RuntimeError('x'), 'b', (), {}, None)
    prune_task_results.on_failure(RuntimeError('x'), 'c', (), {}, None)
    clock[0] += base.FAILURE_NOTIFY_INTERVAL_SECONDS
    prune_logs.on_failure(RuntimeError('x'), 'd', (), {}, None)

    deadline = time.monotonic() + 2
    while len(pushed) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    time.sleep(0.05)
    ids = sorted(msg.split('（')[1].split('）')[0] for msg in pushed)
    assert ids == ['a', 'c', 'd'], pushed


def test_without_a_pool_loop_on_failure_only_logs(monkeypatch, pushed) -> None:
    """eager 模式 / 不是 AsyncIOPool：没有能投的循环，不能抛（会把任务失败变成第二次失败），也不留没 await 的协程"""
    monkeypatch.setattr(celery_aio_pool.AsyncIOPool, 'singleton', None)
    prune_logs.on_failure(RuntimeError('x'), 'e', (), {}, None)
    assert pushed == []


def test_task_notification_goes_to_each_users_room_only(monkeypatch) -> None:
    """不再有不带房间的广播"""
    from backend.common.socketio import actions

    calls: list[dict] = []

    async def fake_emit(event: str, data: dict, **kwargs: object) -> None:  # ruff: ignore[unused-async]
        calls.append({'event': event, **kwargs})

    monkeypatch.setattr(actions.sio, 'emit', fake_emit)
    asyncio.run(actions.task_notification('hi', [1, 2]))
    assert calls == [
        {'event': 'task_notification', 'room': 'user:1'},
        {'event': 'task_notification', 'room': 'user:2'},
    ]
    calls.clear()
    asyncio.run(actions.task_notification('hi', []))
    assert calls == []


# ── 受众：现在能看执行记录的人 ───────────────────────────────────────────────

PASSWORD = 'Notify@123456'


def _call(client, fn, *args, **kwargs):
    return client.portal.call(functools.partial(fn, *args, **kwargs))


@pytest.fixture
def people(client):
    """watcher：角色挂着「执行记录」· bystander：角色只有用户列表 · off：有「执行记录」但账号停用"""
    suffix = uuid.uuid4().hex[:12]
    users: dict[str, int] = {}
    roles: list[int] = []

    async def setup() -> None:
        async with async_test_db_session.begin() as db:
            dept_id = await db.scalar(select(Dept.id).where(Dept.deleted == 0, Dept.status == 1).order_by(Dept.id))
            menu_ids = {
                m.perms: m.id
                for m in (
                    await db.scalars(select(Menu).where(Menu.perms.in_([notify.TASK_RESULT_PERM, 'sys:user:list'])))
                ).all()
            }
            assert set(menu_ids) == {notify.TASK_RESULT_PERM, 'sys:user:list'}, menu_ids
            for key, perm in [('watch', notify.TASK_RESULT_PERM), ('other', 'sys:user:list')]:
                role = Role(code=f'NTF{key.upper()}{suffix.upper()}', name=f'notify-{key}-{suffix}')
                db.add(role)
                await db.flush()
                roles.append(role.id)
                await db.execute(insert(role_menu).values(role_id=role.id, menu_id=menu_ids[perm]))
            salt = bcrypt.gensalt()
            hashed = get_hash_password(PASSWORD, salt)
            for key, role_id, status in [('watcher', roles[0], 1), ('bystander', roles[1], 1), ('off', roles[0], 0)]:
                user = User(
                    username=f'ntf_{key}_{suffix}', nickname=key, password=hashed, salt=salt,
                    dept_id=dept_id, is_staff=True, status=status,
                )  # fmt: skip
                db.add(user)
                await db.flush()
                users[key] = user.id
                await db.execute(insert(user_role).values(user_id=user.id, role_id=role_id))

    async def teardown() -> None:
        ids = list(users.values())
        for pk in ids:
            await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{pk}')
        async with async_test_db_session.begin() as db:
            await db.execute(delete(user_role).where(user_role.c.user_id.in_(ids)))
            await db.execute(delete(User).where(User.id.in_(ids)))
            await db.execute(delete(role_menu).where(role_menu.c.role_id.in_(roles)))
            await db.execute(delete(Role).where(Role.id.in_(roles)))

    try:
        _call(client, setup)
        yield users
    finally:
        _call(client, teardown)


def _superusers(client) -> set[int]:
    async def go() -> set[int]:
        async with async_test_db_session() as db:
            rows = await db.scalars(
                select(User.id).where(User.is_superuser.is_(True), User.status == 1, User.deleted == 0)
            )
            return set(rows.all())

    return _call(client, go)


def test_watchers_are_exactly_those_who_can_open_the_task_records(client, people) -> None:
    ids = set(_call(client, notify.task_watcher_ids))
    supers = _superusers(client)
    assert supers, '前提：种子里得有启用的超管'
    assert supers <= ids, '超管看得到执行记录，也该收到提示'
    assert people['watcher'] in ids
    assert people['bystander'] not in ids, '没有执行记录权限的人收到了任务提示'
    assert people['off'] not in ids, '停用的账号收到了任务提示'


def test_watchers_follow_the_menu_status(client, people) -> None:
    """「执行记录」菜单停用 = 这个码失效（同 `rbac_verify`）：判据走 `user_has_perm`，不是 SQL 自己再判一遍"""
    from sqlalchemy import update

    async def set_menu_status(status: int) -> None:
        async with async_test_db_session.begin() as db:
            await db.execute(update(Menu).where(Menu.perms == notify.TASK_RESULT_PERM).values(status=status))
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{people["watcher"]}')

    _call(client, set_menu_status, 0)
    try:
        assert people['watcher'] not in set(_call(client, notify.task_watcher_ids))
    finally:
        _call(client, set_menu_status, 1)
