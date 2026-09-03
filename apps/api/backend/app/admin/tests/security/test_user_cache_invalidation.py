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


def test_update_dept_clears_cached_users_snapshot(client: TestClient, token_headers: dict[str, str]) -> None:
    """issue #58：改部门（含禁用）要清该部门下用户的 `fba:user:{id}` 快照

    缓存的用户 DTO 里嵌着整个 `dept`（含 `status`）——不清的话被禁用部门下的
    用户继续被当成"部门正常"放行，最长锁死一个 `TOKEN_EXPIRE_SECONDS`。
    把 admin 临时挪进一个新建的测试专用部门（结束后挪回去），不依赖 admin
    原来挂在哪个部门。
    """
    import asyncio as _asyncio

    from sqlalchemy import select
    from sqlalchemy import update as sa_update

    from backend.app.admin.model import User
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    # ⚠️ 不能复用共享的 `async_test_db_session`——它已经被 `conftest.py` 的依赖
    # 覆盖绑到 TestClient 自己的事件循环上了，这里的 `asyncio.run()` 是另起的
    # 一个循环，用会 "attached to a different loop"（同 `_redis_exists` 那条注释
    # 是同一个坑）。每次新建一个独立引擎，跟 `test_data_permission.py` 的
    # `_build`/`_teardown` 是同一个套路。
    async def _get_admin_dept_id() -> int | None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker() as session:
                result = await session.execute(select(User.dept_id).where(User.id == admin_user_id))
                return result.scalar_one()
        finally:
            await engine.dispose()

    async def _set_admin_dept_id(dept_id: int | None) -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker.begin() as session:
                await session.execute(sa_update(User).where(User.id == admin_user_id).values(dept_id=dept_id))
        finally:
            await engine.dispose()

    access_token = token_headers['Authorization'].split(' ', 1)[1]
    admin_user_id = jwt_decode(access_token).user_id

    dept_code = f'ZCACHETEST{uuid.uuid4().hex[:10].upper()}'
    create_resp = client.post(
        '/sys/depts',
        json={'name': dept_code, 'code': dept_code, 'status': 1, 'sort': 0},
        headers=token_headers,
    )
    assert create_resp.status_code == 200, create_resp.text

    tree_resp = client.get('/sys/depts', params={'code': dept_code}, headers=token_headers)
    assert tree_resp.status_code == 200, tree_resp.text
    tree_items = tree_resp.json()['data']
    assert tree_items, f'刚创建的部门 {dept_code} 应该能被 code 过滤查到'
    dept_pk = tree_items[0]['id']

    original_dept_id = _asyncio.run(_get_admin_dept_id())

    try:
        _asyncio.run(_set_admin_dept_id(int(dept_pk)))

        # 挪部门是直接改库，不经过任何 clear_* 调用——这一步之后要显式打一次
        # 认证接口，把（新的）dept_id 写进快照，才有东西可以被接下来的更新清掉
        snapshot_key = f'{settings.JWT_USER_REDIS_PREFIX}:{admin_user_id}'
        warm_resp = client.get('/sys/menus/sidebar', headers=token_headers)
        assert warm_resp.status_code == 200, warm_resp.text
        assert _redis_exists(snapshot_key), '打完一个认证接口之后，admin 的用户快照应该已经被写进 Redis'

        update_resp = client.put(
            f'/sys/depts/{dept_pk}',
            json={'name': dept_code, 'status': 0, 'sort': 0},  # 禁用
            headers=token_headers,
        )
        assert update_resp.status_code == 200, update_resp.text

        assert not _redis_exists(snapshot_key), (
            '禁用部门之后，该部门下用户（这里是 admin）的快照应该已经被清掉，'
            '不能继续拿旧的 dept.status 放行到下次别的操作才清'
        )
    finally:
        _asyncio.run(_set_admin_dept_id(original_dept_id))
        client.request('DELETE', f'/sys/depts/{dept_pk}', headers=token_headers)


def test_update_menu_clears_the_snapshot_of_users_who_have_it(
    client: TestClient, token_headers: dict[str, str]
) -> None:
    """`PUT /sys/menus/{pk}` 必须清掉持有该菜单的用户快照。

    这个入口此前没测过。不清的后果**不是报错，是权限改了不生效**：
    快照里装着 `roles[].menus[]`（见 `GetUserInfoWithRelationDetail`），
    而它的 TTL 是 `TOKEN_EXPIRE_SECONDS`（默认一天）——
    收回一个按钮权限之后，那个用户**还能继续点一整天**。

    ⚠️ 回写的是菜单**原样的字段**，不改任何东西 —— 这条测的是「有没有清缓存」，
    不是「能不能改菜单」。改内容会牵动侧边栏和权限码，收尾不干净就污染别的测试。
    """
    access_token = token_headers['Authorization'].split(' ', 1)[1]
    admin_user_id = jwt_decode(access_token).user_id
    snapshot_key = f'{settings.JWT_USER_REDIS_PREFIX}:{admin_user_id}'

    tree = client.get('/sys/menus', headers=token_headers)
    assert tree.status_code == 200, tree.text
    menu = tree.json()['data'][0]

    # 先把快照焐热 —— 否则「被清掉」和「本来就没有」分不开
    assert client.get('/sys/menus/sidebar', headers=token_headers).status_code == 200
    assert _redis_exists(snapshot_key), '打完一个认证接口之后，快照应该已经在 Redis 里'

    res = client.put(
        f'/sys/menus/{menu["id"]}',
        headers=token_headers,
        json={
            'title': menu['title'],
            'name': menu['name'],
            'path': menu['path'],
            'parent_id': menu['parent_id'],
            'sort': menu['sort'],
            'icon': menu['icon'],
            'type': menu['type'],
            'perms': menu['perms'],
            'status': menu['status'],
            'display': menu['display'],
            'link': menu['link'],
            'remark': menu['remark'],
        },
    )
    assert res.status_code == 200, res.text
    assert not _redis_exists(snapshot_key), (
        '改完菜单，持有它的用户快照必须已经被清 —— 不清就是「权限改了，'
        f'但那个用户还有 {settings.TOKEN_EXPIRE_SECONDS} 秒照旧」'
    )


def test_update_data_rule_clears_the_snapshot_of_users_in_that_scope(
    client: TestClient, token_headers: dict[str, str], temp_user: str
) -> None:
    """`PUT /sys/data-rules/{pk}` 必须清掉受该规则影响的用户快照。

    🔴 这条比菜单那条更要紧：快照里装着 `roles[].scopes[].rules[]`
    （`GetDataScopeWithRelationDetail`），也就是**行级过滤的依据**。
    不清的后果是「收窄了数据范围，但那个用户还能看到本该看不到的行」——
    最长一天，而且没有任何现象。

    ⚠️ 数据范围在种子里绑的是 MANAGER / FINANCE_STAFF / VIEWER，**不是 ADMIN**
    （超管绕过数据权限），所以不能像菜单那条一样拿 admin 自己当受害者 ——
    要造一个真的落在那条链上的用户：
    临时用户 → 加进 MANAGER 角色 → 用它登录把快照焐热。
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    manager = next((r for r in roles if r['code'] == 'MANAGER'), None)
    assert manager, '种子里应该有 MANAGER 角色（数据范围演示用）'

    scope_ids = client.get(f'/sys/roles/{manager["id"]}/scopes', headers=token_headers).json()['data'] or []
    assert scope_ids, 'MANAGER 角色应该绑着数据范围'
    rules = client.get(f'/sys/data-scopes/{scope_ids[0]}/rules', headers=token_headers).json()['data']
    rule = (rules if isinstance(rules, list) else rules.get('rules', []))[0]

    # 把临时用户加进 MANAGER —— 这样它才真的落在这条数据规则的影响范围里
    add = client.post(f'/sys/roles/{manager["id"]}/users', headers=token_headers, json={'users': [temp_user]})
    assert add.status_code == 200, add.text

    snapshot_key = f'{settings.JWT_USER_REDIS_PREFIX}:{temp_user}'
    try:
        # 用临时用户自己登录，把它的快照焐热（admin 的快照证明不了这条）
        login = client.post('/auth/login/swagger', params={'username': 'pytest_tmp_writes', 'password': 'Tmp@123456'})
        assert login.status_code == 200, f'临时用户登不进来：{login.text}'
        tmp_headers = {'Authorization': f'Bearer {login.json()["access_token"]}'}
        assert client.get('/sys/users/me', headers=tmp_headers).status_code == 200
        assert _redis_exists(snapshot_key), '临时用户打过认证接口之后，它的快照应该在 Redis 里'

        res = client.put(
            f'/sys/data-rules/{rule["id"]}',
            headers=token_headers,
            json={
                'name': rule['name'],
                'model': rule['model'],
                'column': rule['column'],
                'operator': rule['operator'],
                'expression': rule['expression'],
                'value': rule['value'],
            },
        )
        assert res.status_code == 200, res.text
        assert not _redis_exists(snapshot_key), (
            '改完数据规则，受影响用户的快照必须已经被清 —— 不清就是「数据范围收窄了，但那个用户还能看到本该看不到的行」'
        )
    finally:
        client.request(
            'DELETE', f'/sys/roles/{manager["id"]}/users', headers=token_headers, json={'users': [temp_user]}
        )
