"""#312：删除账号的保护、数据范围、并发锁和提交后的会话撤销。"""

import asyncio
import functools
import uuid

from types import SimpleNamespace
from unittest.mock import AsyncMock

import bcrypt
import pytest

from sqlalchemy import delete, event, func, insert, select, update
from sqlalchemy.dialects import mssql, mysql, postgresql
from sqlalchemy.orm import Session
from starlette.background import BackgroundTasks

from backend.app.admin.crud.crud_user import user_dao
from backend.app.admin.model import Dept, Menu, Role, User, role_menu, user_role
from backend.app.admin.service.user_service import user_service
from backend.app.admin.utils.password_security import get_hash_password
from backend.common.exception import errors
from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.tests.utils.db import async_test_db_session

PASSWORD = 'Delete@123456'


def _call(client, fn, *args, **kwargs):
    return client.portal.call(functools.partial(fn, *args, **kwargs))


def _login(client, username):
    response = client.post('/auth/login/swagger', params={'username': username, 'password': PASSWORD})
    assert response.status_code == 200, response.text
    return {'Authorization': f'Bearer {response.json()["access_token"]}'}


@pytest.fixture
def accounts(client, no_captcha):
    suffix = uuid.uuid4().hex[:12]
    users = {}
    roles = []

    async def setup():
        async with async_test_db_session.begin() as db:
            dept_id = await db.scalar(select(Dept.id).where(Dept.deleted == 0, Dept.status == 1).order_by(Dept.id))
            menu_ids = {
                menu.perms: menu.id
                for menu in (
                    await db.scalars(select(Menu).where(Menu.perms.in_(['sys:user:del', 'sys:user:list'])))
                ).all()
            }
            assert set(menu_ids) == {'sys:user:del', 'sys:user:list'}
            for key, perms in [('deleter', list(menu_ids)), ('reader', ['sys:user:list'])]:
                role = Role(
                    code=f'DEL{key.upper()}{suffix.upper()}', name=f'delete-{key}-{suffix}', is_filter_scopes=False
                )
                db.add(role)
                await db.flush()
                roles.append(role.id)
                await db.execute(insert(role_menu), [{'role_id': role.id, 'menu_id': menu_ids[p]} for p in perms])
            salt = bcrypt.gensalt()
            hashed = get_hash_password(PASSWORD, salt)
            for key in ['deleter', 'reader', 'target', 'super']:
                user = User(
                    username=f'del_{key}_{suffix}',
                    nickname=key,
                    password=hashed,
                    salt=salt,
                    dept_id=dept_id,
                    is_staff=True,
                    is_superuser=key == 'super',
                )
                db.add(user)
                await db.flush()
                users[key] = {'id': user.id, 'username': user.username}
                await db.execute(insert(user_role).values(user_id=user.id, role_id=roles[key == 'reader']))

    async def teardown():
        ids = [user['id'] for user in users.values()]
        for pk in ids:
            await session_store.revoke_user(pk, EndReason.logout)
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


async def _state(pk):
    async with async_test_db_session() as db:
        row = (await db.execute(select(User.deleted, User.is_superuser).where(User.id == pk))).one()
        role = await db.scalar(select(user_role.c.role_id).where(user_role.c.user_id == pk))
        return row.deleted, row.is_superuser, role


async def _set_user(pk, **values):
    async with async_test_db_session.begin() as db:
        await db.execute(update(User).where(User.id == pk).values(**values))
    await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{pk}')


@pytest.mark.parametrize('actor', ['deleter', 'super'])
def test_cannot_delete_yourself(client, accounts, actor):
    user = accounts[actor]
    headers = _login(client, user['username'])
    response = client.delete(f'/sys/users/{user["id"]}', headers=headers)
    assert response.status_code == 403, response.text
    assert '当前登录账号' in response.json()['msg']
    assert _call(client, _state, user['id'])[0] == 0
    assert client.get('/sys/users/me', headers=headers).status_code == 200


@pytest.mark.parametrize('actor', ['deleter', 'super'])
@pytest.mark.parametrize('disabled', [False, True])
def test_no_one_can_directly_delete_a_superuser(client, token_headers, accounts, actor, disabled):
    target = accounts['super']
    headers = token_headers if actor == 'super' else _login(client, accounts['deleter']['username'])
    if disabled:
        _call(client, _set_user, target['id'], status=0, is_staff=False)
    before = _call(client, _state, target['id'])
    response = client.delete(f'/sys/users/{target["id"]}', headers=headers)
    assert response.status_code == 403, response.text
    assert '超级管理员' in response.json()['msg']
    assert _call(client, _state, target['id']) == before


def test_delete_still_requires_the_button_permission(client, accounts):
    target = accounts['target']['id']
    headers = _login(client, accounts['reader']['username'])
    response = client.delete(f'/sys/users/{target}', headers=headers)
    assert response.status_code == 403, response.text
    assert _call(client, _state, target)[0] == 0
    assert client.delete(f'/sys/users/{target}').status_code == 401


@pytest.mark.parametrize('actor', ['deleter', 'super'])
def test_deleting_an_ordinary_user_ends_all_sessions_after_commit(client, token_headers, accounts, actor):
    target = accounts['target']
    headers = token_headers if actor == 'super' else _login(client, accounts['deleter']['username'])
    sessions = []
    for kind in ['web', 'desktop', 'mobile']:
        client.cookies.clear()
        response = client.post(
            '/auth/login', json={'username': target['username'], 'password': PASSWORD, 'client': kind}
        )
        assert response.status_code == 200, response.text
        refresh = client.cookies.get(settings.COOKIE_REFRESH_TOKEN_KEY)
        assert refresh
        sessions.append((response.json()['data']['access_token'], refresh))
    client.cookies.clear()
    cache_key = f'{settings.JWT_USER_REDIS_PREFIX}:{target["id"]}'
    target_headers = {'Authorization': f'Bearer {sessions[0][0]}'}
    assert client.get('/sys/users/me', headers=target_headers).status_code == 200
    assert _call(client, redis_client.exists, cache_key)
    # 相邻 ID 的快照不该被 delete_by_prefix 一并清掉。
    neighbour = f'{cache_key}0'
    _call(client, redis_client.set, neighbour, 'keep', ex=60)
    order = []
    original_revoke = session_store.revoke_user

    def committed(_session):
        order.append('commit')

    async def revoke(*args):
        order.append('revoke')
        assert order[0] == 'commit', order
        assert (await _state(target['id']))[0] == target['id']
        await original_revoke(*args)

    event.listen(Session, 'after_commit', committed)
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(session_store, 'revoke_user', revoke)
            response = client.delete(f'/sys/users/{target["id"]}', headers=headers)
        assert (response.status_code, response.json()['code']) == (200, 200), response.text
        assert 'revoke' in order
        assert _call(client, _state, target['id']) == (target['id'], False, None)
        assert not _call(client, redis_client.exists, cache_key)
        assert _call(client, redis_client.get, neighbour) == 'keep'
        for access, refresh in sessions:
            assert client.get('/sys/users/me', headers={'Authorization': f'Bearer {access}'}).status_code == 401
            client.cookies.set(settings.COOKIE_REFRESH_TOKEN_KEY, refresh)
            refreshed = client.post('/auth/refresh')
            client.cookies.clear()
            assert refreshed.status_code == 401, refreshed.text
        assert client.delete(f'/sys/users/{target["id"]}', headers=headers).status_code == 404
    finally:
        event.remove(Session, 'after_commit', committed)
        client.cookies.clear()
        _call(client, redis_client.delete, neighbour)


def test_a_failed_commit_keeps_the_account_cache_and_session(client, token_headers, accounts, monkeypatch):
    target = accounts['target']
    headers = _login(client, target['username'])
    assert client.get('/sys/users/me', headers=headers).status_code == 200
    cache_key = f'{settings.JWT_USER_REDIS_PREFIX}:{target["id"]}'
    assert _call(client, redis_client.exists, cache_key)
    before = _call(client, _state, target['id'])
    revoke = AsyncMock()
    monkeypatch.setattr(session_store, 'revoke_user', revoke)

    def fail_delete(session):
        if session.connection().scalar(select(User.deleted).where(User.id == target['id'])) != 0:
            raise RuntimeError('delete commit failed')

    event.listen(Session, 'before_commit', fail_delete)
    try:
        with pytest.raises(RuntimeError, match='delete commit failed'):
            client.delete(f'/sys/users/{target["id"]}', headers=token_headers)
    finally:
        event.remove(Session, 'before_commit', fail_delete)
    revoke.assert_not_awaited()
    assert _call(client, _state, target['id']) == before
    assert _call(client, redis_client.exists, cache_key)
    assert client.get('/sys/users/me', headers=headers).status_code == 200


def test_a_nonexistent_user_returns_404(client, token_headers):
    assert client.delete('/sys/users/999999999999999999', headers=token_headers).status_code == 404


def test_delete_keeps_the_callers_data_scope(client, accounts):
    actor = accounts['deleter']
    headers = _login(client, actor['username'])

    async def restrict():
        async with async_test_db_session.begin() as db:
            role_id = await db.scalar(select(user_role.c.role_id).where(user_role.c.user_id == actor['id']))
            await db.execute(update(Role).where(Role.id == role_id).values(is_filter_scopes=True))
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{actor["id"]}')

    _call(client, restrict)
    target = accounts['target']['id']
    response = client.delete(f'/sys/users/{target}', headers=headers)
    assert response.status_code == 404, response.text
    assert _call(client, _state, target)[0] == 0
    # 即使数据范围看不到本人，也应明确拒绝自删。
    own = client.delete(f'/sys/users/{actor["id"]}', headers=headers)
    assert own.status_code == 403 and '当前登录账号' in own.json()['msg']


def test_the_last_superuser_is_protected(client, accounts):
    target = accounts['super']['id']

    async def attempt():
        async with async_test_db_session() as db:
            try:
                # 只在未提交事务里构造「唯一超管」，不能把种子管理员真的降权。
                await db.execute(update(User).where(User.id != target).values(is_superuser=False))
                count = await db.scalar(
                    select(func.count()).select_from(User).where(User.is_superuser, User.deleted == 0)
                )
                assert count == 1
                tasks = BackgroundTasks()
                request = SimpleNamespace(user=SimpleNamespace(id=accounts['deleter']['id']))
                with pytest.raises(errors.ForbiddenError, match='超级管理员'):
                    await user_service.delete(db=db, request=request, background_tasks=tasks, pk=target)
                assert not tasks.tasks
                assert await db.scalar(select(User.deleted).where(User.id == target)) == 0
            finally:
                await db.rollback()

    _call(client, attempt)


def test_a_concurrent_promotion_is_seen_before_deleting(client, accounts):
    target = accounts['target']['id']

    async def attempt():
        async def delete_target():
            async with async_test_db_session.begin() as db:
                tasks = BackgroundTasks()
                request = SimpleNamespace(user=SimpleNamespace(id=accounts['deleter']['id']))
                with pytest.raises(errors.ForbiddenError, match='超级管理员'):
                    await user_service.delete(db=db, request=request, background_tasks=tasks, pk=target)
                assert not tasks.tasks

        async with async_test_db_session.begin() as promotion:
            await promotion.execute(update(User).where(User.id == target).values(is_superuser=True))
            pending = asyncio.create_task(delete_target())
            try:
                with pytest.raises(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(pending), timeout=0.1)
            except BaseException:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                raise
        await asyncio.wait_for(pending, timeout=5)

    _call(client, attempt)
    assert _call(client, _state, target)[:2] == (0, True)


@pytest.mark.parametrize('dialect', [postgresql.dialect(), mysql.dialect(), mssql.dialect()])
def test_delete_locks_are_emitted_for_each_supported_database(client, dialect):
    class Capture:
        async def scalar(self, stmt):
            sql = str(stmt.compile(dialect=dialect))
            if dialect.name == 'mssql':
                assert 'WITH (UPDLOCK, HOLDLOCK)' in sql
            else:
                assert 'FOR UPDATE' in sql
            assert stmt.get_execution_options()['populate_existing']

    _call(client, user_dao.get_for_delete, Capture(), 1)
