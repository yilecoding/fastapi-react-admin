"""#394 ③：停用 / 重置密码 / 改自己的密码 —— 踢会话要等提交之后（#312 已把删除用户的挪过去）。

在事务中途 `await session_store.revoke_user`：提交失败时状态 / 密码回滚了，人却已经被全端踢下线、记了「强制下线」；
撤销到提交之间旧密码还能登录、建出一个活过这次改密的新会话。
"""

import functools
import uuid

from unittest.mock import AsyncMock

import bcrypt
import pytest

from sqlalchemy import delete, event, insert, select
from sqlalchemy.orm import Session

from backend.app.admin.model import Dept, Role, User, user_role
from backend.app.admin.utils.password_security import get_hash_password
from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.tests.utils.db import async_test_db_session

PASSWORD = 'Revoke@123456'
NEW_PASSWORD = 'Changed@654321'


def _call(client, fn, *args, **kwargs):
    return client.portal.call(functools.partial(fn, *args, **kwargs))


@pytest.fixture
def target(client, no_captcha):
    suffix = uuid.uuid4().hex[:12]
    holder = {}

    async def setup():
        async with async_test_db_session.begin() as db:
            dept_id = await db.scalar(select(Dept.id).where(Dept.deleted == 0, Dept.status == 1).order_by(Dept.id))
            role_id = await db.scalar(select(Role.id).where(Role.code == 'STAFF'))
            salt = bcrypt.gensalt()
            user = User(
                username=f'rv_{suffix}',
                nickname='revoke',
                password=get_hash_password(PASSWORD, salt),
                salt=salt,
                dept_id=dept_id,
                is_staff=True,
            )
            db.add(user)
            await db.flush()
            await db.execute(insert(user_role).values(user_id=user.id, role_id=role_id))
            holder.update(id=user.id, username=user.username, hash=user.password)

    async def teardown():
        await session_store.revoke_user(holder['id'], EndReason.logout)
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{holder["id"]}')
        async with async_test_db_session.begin() as db:
            await db.execute(delete(user_role).where(user_role.c.user_id == holder['id']))
            await db.execute(delete(User).where(User.id == holder['id']))

    _call(client, setup)
    try:
        yield holder
    finally:
        _call(client, teardown)


def _login(client, username, password=PASSWORD):
    response = client.post('/auth/login/swagger', params={'username': username, 'password': password})
    assert response.status_code == 200, response.text
    return {'Authorization': f'Bearer {response.json()["access_token"]}'}


def _send(client, action, user, admin_headers, own_headers):
    if action == 'disable':
        return client.put(f'/sys/users/{user["id"]}/permissions', params={'type': 'status'}, headers=admin_headers)
    if action == 'reset':
        return client.put(f'/sys/users/{user["id"]}/password', json={'password': NEW_PASSWORD}, headers=admin_headers)
    body = {'old_password': PASSWORD, 'new_password': NEW_PASSWORD, 'confirm_password': NEW_PASSWORD}
    return client.put('/sys/users/me/password', json=body, headers=own_headers)


def _changed(session, user):
    row = session.connection().execute(select(User.status, User.password).where(User.id == user['id'])).one()
    return row.status != 1 or row.password != user['hash']


ACTIONS = ['disable', 'reset', 'self']


@pytest.mark.parametrize('action', ACTIONS)
def test_a_failed_commit_does_not_kick_anyone(client, token_headers, target, monkeypatch, action):
    own = _login(client, target['username'])
    assert client.get('/sys/users/me', headers=own).status_code == 200
    revoke = AsyncMock()
    monkeypatch.setattr(session_store, 'revoke_user', revoke)

    def fail(session):
        if _changed(session, target):
            raise RuntimeError('commit failed')

    event.listen(Session, 'before_commit', fail)
    try:
        with pytest.raises(RuntimeError, match='commit failed'):
            _send(client, action, target, token_headers, own)
    finally:
        event.remove(Session, 'before_commit', fail)
    revoke.assert_not_awaited()
    monkeypatch.undo()
    # 状态和密码都回滚了，会话也该原样还在
    assert client.get('/sys/users/me', headers=own).status_code == 200
    _login(client, target['username'])


@pytest.mark.parametrize('action', ACTIONS)
def test_sessions_are_revoked_after_the_commit(client, token_headers, target, action):
    own = _login(client, target['username'])
    order = []
    original = session_store.revoke_user

    changing: set[int] = set()

    def about_to_commit(session):
        if _changed(session, target):
            changing.add(id(session))

    def committed(session):
        # 只认真正落库的那一下：before_commit 在 COMMIT 之前，记在那里证明不了「提交成功之后」
        if id(session) in changing and not session.in_nested_transaction():
            changing.discard(id(session))
            order.append('commit')

    async def revoke(*args):
        order.append('revoke')
        await original(*args)

    event.listen(Session, 'before_commit', about_to_commit)
    event.listen(Session, 'after_commit', committed)
    try:
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(session_store, 'revoke_user', revoke)
            response = _send(client, action, target, token_headers, own)
    finally:
        event.remove(Session, 'before_commit', about_to_commit)
        event.remove(Session, 'after_commit', committed)
    assert (response.status_code, response.json()['code']) == (200, 200), response.text
    assert 'revoke' in order, order
    assert order.index('commit') < order.index('revoke'), order
    assert client.get('/sys/users/me', headers=own).status_code == 401
