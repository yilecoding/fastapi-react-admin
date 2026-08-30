"""issue #34：用户权限快照（`fba:user:{id}`）的清理时机 / 覆盖面。

真相来源不是数据库，是一份 TTL = `TOKEN_EXPIRE_SECONDS`（默认 1 天）的 Redis 快照
（`JWT_USER_REDIS_PREFIX`）——`menu_service.get_sidebar()` 筛菜单用的 `menu_ids`
来自这份快照，不是每次都重新算。这批用例钉住两件事：

1. `UserCacheManager.clear()` 不能在事务提交前直接删 Redis：所有 `clear_*` 都是从
   `CurrentSessionTransaction` 端点内调用的，而那类端点的 commit 发生在 handler
   函数体返回之后（`get_db_transaction` 的 `async with async_db_session.begin()`
   在依赖退出时才提交）。真正的删除必须registered 为 `BackgroundTasks`——它保证
   在依赖退出栈（含 commit）关闭之后、响应发出之前才执行，天生晚于提交。
2. `logout` 必须把这份快照一起清掉，否则一旦被问题 1 描述的竞态卡在旧值上，
   重新登录（用户唯一想得到的自救动作）并不能恢复它。
"""

import asyncio
import uuid

from unittest.mock import AsyncMock

import pytest

from starlette.background import BackgroundTasks
from starlette.testclient import TestClient

from backend.app.admin.utils import cache as cache_module
from backend.app.admin.utils.cache import user_cache_manager
from backend.common.security.jwt import jwt_decode
from backend.core.conf import settings
from backend.database.redis import RedisCli


def _redis_exists(key: str) -> bool:
    """开一个独立连接查 key 存在与否

    ⚠️ 不能用模块级的全局 `redis_client`——它绑在 `TestClient` 的事件循环上，
    从这里新起的 `asyncio.run()` 循环里用会 "attached to a different loop"
    （同 `test_auth.py: _clear_login_counters` 踩过的坑）。
    """

    async def _check() -> bool:
        client = RedisCli()
        try:
            return bool(await client.exists(key))
        finally:
            await client.aclose()

    return asyncio.run(_check())


def test_clear_registers_redis_delete_as_background_task(monkeypatch: pytest.MonkeyPatch) -> None:
    """`clear()` 必须把真正的删除挂成 background task，不能立刻执行

    用 mock 而不是真实 Redis 连接，是为了避开上面那个"跨事件循环"的坑：
    `AsyncMock` 不绑定任何循环，可以放心在这里新起的 `asyncio.run()` 里驱动。
    """
    mock_delete = AsyncMock()
    monkeypatch.setattr(cache_module.redis_client, 'delete', mock_delete)

    background_tasks = BackgroundTasks()
    user_cache_manager.clear(background_tasks, [123456, 654321])

    # 此刻——相当于"事务还没提交"的那一刻——真正的 Redis 删除还不能发生
    mock_delete.assert_not_called()

    # 模拟 FastAPI 在响应发出前执行 background tasks（commit 已经在此之前完成）
    asyncio.run(background_tasks())

    mock_delete.assert_called_once_with(
        f'{settings.JWT_USER_REDIS_PREFIX}:123456',
        f'{settings.JWT_USER_REDIS_PREFIX}:654321',
    )


def test_update_role_menus_clears_admin_snapshot_by_the_time_response_returns(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """端到端回归：改角色菜单，admin 自己的 `fba:user:{id}` 必须已经被清

    走真实的 `PUT /sys/roles/{pk}/menus`，而不是直接调 service 函数——
    这条测试同时验证了"background task 真的被 FastAPI 执行了"这件事本身，
    单测 `UserCacheManager` 证明不了这个（mock 不会漏接，但接口层可能忘了
    把 `background_tasks` 参数一路传下去）。
    """
    access_token = token_headers['Authorization'].split(' ', 1)[1]
    admin_user_id = jwt_decode(access_token).user_id

    role_code = f'ZCACHETEST{uuid.uuid4().hex[:10].upper()}'
    create_resp = client.post(
        '/sys/roles',
        json={'name': role_code, 'code': role_code, 'status': 1, 'remark': None},
        headers=token_headers,
    )
    assert create_resp.status_code == 200, create_resp.text

    list_resp = client.get('/sys/roles', params={'code': role_code}, headers=token_headers)
    assert list_resp.status_code == 200, list_resp.text
    items = list_resp.json()['data']['items']
    assert items, f'刚创建的角色 {role_code} 应该能被 code 过滤查到'
    role_pk = items[0]['id']

    try:
        add_users_resp = client.post(
            f'/sys/roles/{role_pk}/users',
            json={'users': [admin_user_id]},
            headers=token_headers,
        )
        assert add_users_resp.status_code == 200, add_users_resp.text

        # ⚠️ `add_users` 自己也会清一次 admin 的缓存（刚把 admin 加进这个角色，
        # 它自己的权限就变了）——所以这里的快照这时候已经是空的，不能拿来当
        # "写入过"的证据。用一次无关的认证请求重新把它填回去，才能确认接下来
        # `update_role_menus` 造成的删除是它自己的效果，不是延续上一步。
        snapshot_key = f'{settings.JWT_USER_REDIS_PREFIX}:{admin_user_id}'
        warm_resp = client.get('/sys/menus/sidebar', headers=token_headers)
        assert warm_resp.status_code == 200, warm_resp.text
        assert _redis_exists(snapshot_key), '打完一个认证接口之后，admin 的用户快照应该已经被写进 Redis'

        update_resp = client.put(
            f'/sys/roles/{role_pk}/menus',
            json={'menus': []},
            headers=token_headers,
        )
        assert update_resp.status_code == 200, update_resp.text

        # `TestClient` 会跑完包括 background tasks 在内的整条 ASGI 响应流程
        # 才把 response 对象交回来，所以这里能看到的必须是"已经清掉"。
        assert not _redis_exists(snapshot_key), (
            '响应已经返回，说明 commit + background task 都已经跑完，'
            'admin 的用户快照这时候应该已经被清掉，不是等到下次别的操作才清'
        )
    finally:
        client.request(
            'DELETE',
            f'/sys/roles/{role_pk}/users',
            json={'users': [admin_user_id]},
            headers=token_headers,
        )
        client.request('DELETE', '/sys/roles', json={'pks': [role_pk]}, headers=token_headers)


def test_logout_clears_user_snapshot(client: TestClient) -> None:
    """logout 必须清掉 `fba:user:{id}`，否则问题 1 一旦发生就没有自救路径

    ⚠️ 故意不用共享的 `token_headers`（module 级 fixture）——那个 token 还要给
    同模块的其它用例用，这里 logout 会让它失效，所以自己单独登录一次。
    """
    login_resp = client.post(
        '/auth/login/swagger',
        params={'username': 'admin', 'password': '123456'},
    )
    login_resp.raise_for_status()
    body = login_resp.json()
    access_token = body['access_token']
    headers = {'Authorization': f'{body["token_type"]} {access_token}'}
    user_id = jwt_decode(access_token).user_id
    snapshot_key = f'{settings.JWT_USER_REDIS_PREFIX}:{user_id}'

    # 随便打一个带认证的接口，确保快照被写进 Redis（不依赖它是否已经因为
    # 别的用例而存在）
    me_resp = client.get('/sys/menus/sidebar', headers=headers)
    assert me_resp.status_code == 200, me_resp.text
    assert _redis_exists(snapshot_key)

    logout_resp = client.post('/auth/logout', headers=headers)
    assert logout_resp.status_code == 200

    assert not _redis_exists(snapshot_key), (
        'logout 之后 fba:user:{id} 必须被清掉——否则一旦这份快照被卡在旧值上，'
        '重新登录（用户唯一想得到的自救动作）没有任何效果'
    )
