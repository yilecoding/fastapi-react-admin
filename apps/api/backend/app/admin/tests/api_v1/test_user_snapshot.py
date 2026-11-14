"""#313：刷新身份查询不受数据范围限制；用户快照只能在事务提交后作废。"""

import asyncio

from collections.abc import AsyncGenerator
from typing import Any

import httpx
import pytest

from sqlalchemy import delete, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.testclient import TestClient

from backend.app.admin.model import Role, User, user_role
from backend.common.security.session import EndReason, session_store
from backend.core.conf import settings
from backend.database.db import get_db_transaction
from backend.database.redis import redis_client
from backend.tests.utils.db import async_test_db_session


def _login(client: TestClient) -> dict[str, str]:
    response = client.post('/auth/login', json={'username': 'pytest_tmp_writes', 'password': 'Tmp@123456'})
    assert response.status_code == 200, response.text
    return {'Authorization': f'Bearer {response.json()["data"]["access_token"]}'}


@pytest.mark.parametrize('with_bearer', [False, True])
def test_restricted_user_can_refresh_with_or_without_bearer(
    client: TestClient, temp_user: str, no_captcha: None, *, with_bearer: bool
) -> None:
    user_id = int(temp_user)

    async def restrict() -> None:
        async with async_test_db_session.begin() as db:
            staff = (await db.execute(select(Role).where(Role.code == 'STAFF', Role.deleted == 0))).scalar_one()
            assert staff.is_filter_scopes
            await db.execute(delete(user_role).where(user_role.c.user_id == user_id))
            await db.execute(insert(user_role).values(user_id=user_id, role_id=staff.id))
        await redis_client.delete(f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}')

    client.portal.call(restrict)
    try:
        headers = _login(client)
        me = client.get('/sys/users/me', headers=headers)
        assert me.status_code == 200, me.text
        assert not me.json()['data']['is_superuser']
        response = client.post('/auth/refresh', headers=headers if with_bearer else {})
        assert response.status_code == 200, response.text
        refreshed = {'Authorization': f'Bearer {response.json()["data"]["access_token"]}'}
        assert client.get('/sys/users/me', headers=refreshed).status_code == 200
    finally:
        client.portal.call(session_store.revoke_user, user_id, EndReason.logout)
        client.cookies.clear()


@pytest.mark.parametrize('state', ['disabled', 'deleted'])
def test_refresh_still_rejects_a_disabled_or_deleted_account(
    client: TestClient, temp_user: str, no_captcha: None, state: str
) -> None:
    user_id = int(temp_user)
    headers = _login(client)
    assert client.get('/sys/users/me', headers=headers).status_code == 200

    async def invalidate() -> None:
        values = {'status': 0} if state == 'disabled' else {'deleted': user_id}
        async with async_test_db_session.begin() as db:
            await db.execute(update(User).where(User.id == user_id).values(values))

    try:
        # 保留缓存中的旧正常状态，让请求到达 refresh 的查库校验。
        client.portal.call(invalidate)
        response = client.post('/auth/refresh', headers=headers)
        assert response.status_code == 401, response.text
        assert response.json()['data']['reason'] == EndReason.disabled
        assert client.get('/sys/users/me', headers=headers).status_code == 401
    finally:
        client.portal.call(session_store.revoke_user, user_id, EndReason.logout)
        client.cookies.clear()


@pytest.mark.parametrize('permission', ['superuser', 'staff'])
def test_demotion_clears_a_snapshot_refilled_before_commit(
    client: TestClient,
    token_headers: dict[str, str],
    temp_user: str,
    no_captcha: None,
    permission: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user_id = int(temp_user)
    field = f'is_{permission}'
    key = f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}'

    async def promote() -> None:
        async with async_test_db_session.begin() as db:
            await db.execute(update(User).where(User.id == user_id).values({field: True}))
        await redis_client.delete(key)

    client.portal.call(promote)
    headers = _login(client)
    client.cookies.clear()
    warm = client.get('/sys/users/me', headers=headers)
    assert warm.status_code == 200 and warm.json()['data'][field] is True, warm.text

    async def scenario() -> None:
        paused, resume = asyncio.Event(), asyncio.Event()
        loaded, refill = asyncio.Event(), asyncio.Event()
        original_set = redis_client.set

        async def delay_refill(name: str, *args: Any, **kwargs: Any) -> Any:
            if name == key:
                # 先通过独立连接读出旧快照，再暂停 SET；不依赖数据库是否开启读已提交快照。
                loaded.set()
                await asyncio.wait_for(refill.wait(), timeout=15)
            return await original_set(name, *args, **kwargs)

        async def pause_before_commit() -> AsyncGenerator[AsyncSession, None]:
            async with async_test_db_session.begin() as db:
                yield db
                # 真正的 UPDATE 已执行，但事务尚未提交。
                await db.flush()
                paused.set()
                await asyncio.wait_for(resume.wait(), timeout=15)

        previous = client.app.dependency_overrides[get_db_transaction]
        client.app.dependency_overrides[get_db_transaction] = pause_before_commit
        transport = httpx.ASGITransport(app=client.app)
        try:
            async with httpx.AsyncClient(transport=transport, base_url=str(client.base_url)) as http:
                with monkeypatch.context() as patch:
                    patch.setattr(redis_client, 'set', delay_refill)
                    await redis_client.delete(key)
                    reader = asyncio.create_task(http.get('/sys/users/me', headers=headers))
                    writer = None
                    try:
                        await asyncio.wait_for(loaded.wait(), timeout=15)
                        writer = asyncio.create_task(
                            http.put(
                                f'/sys/users/{user_id}/permissions', headers=token_headers, params={'type': permission}
                            )
                        )
                        await asyncio.wait_for(paused.wait(), timeout=15)
                        refill.set()
                        old = await asyncio.wait_for(reader, timeout=10)
                        assert old.status_code == 200 and old.json()['data'][field] is True, old.text
                        assert await redis_client.exists(key), '必须确认旧权限已被重新缓存'
                    finally:
                        refill.set()
                        resume.set()
                        await reader
                        if writer is not None:
                            response = await writer
                assert response.status_code == 200 and response.json()['code'] == 200, response.text
                current = await http.get('/sys/users/me', headers=headers)
                assert current.status_code == 200, current.text
                assert current.json()['data'][field] is False, '提交后仍从缓存拿到已撤销的权限'
        finally:
            client.app.dependency_overrides[get_db_transaction] = previous

    try:
        client.portal.call(scenario)
    finally:
        client.portal.call(session_store.revoke_user, user_id, EndReason.logout)


def test_failed_user_edit_does_not_invalidate_snapshot(
    client: TestClient, token_headers: dict[str, str], temp_user: str, no_captcha: None
) -> None:
    user_id = int(temp_user)
    key = f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}'
    headers = _login(client)
    client.cookies.clear()
    assert client.get('/sys/users/me', headers=headers).status_code == 200
    original = client.portal.call(redis_client.get, key)
    assert original

    async def fail_before_commit() -> AsyncGenerator[AsyncSession, None]:
        async with async_test_db_session.begin() as db:
            yield db
            raise RuntimeError('test: commit failed')

    async def scenario() -> None:
        previous = client.app.dependency_overrides[get_db_transaction]
        client.app.dependency_overrides[get_db_transaction] = fail_before_commit
        try:
            transport = httpx.ASGITransport(app=client.app, raise_app_exceptions=False)
            async with httpx.AsyncClient(transport=transport, base_url=str(client.base_url)) as http:
                response = await http.put('/sys/users/me/nickname', headers=headers, json={'nickname': 'rolled back'})
                assert response.status_code >= 400, response.text
            assert await redis_client.get(key) == original, '回滚时不应执行提交后的缓存清理'
        finally:
            client.app.dependency_overrides[get_db_transaction] = previous

    try:
        client.portal.call(scenario)
    finally:
        client.portal.call(session_store.revoke_user, user_id, EndReason.logout)
