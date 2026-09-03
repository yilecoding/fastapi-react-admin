"""`GET /sys/roles/{pk}/menus` 和 `GET /sys/users/{pk}/roles` 的契约。

两个都是**零覆盖端点**（跑完整套 pytest 会打印那份清单，这两条在里面）。

它们的失败是静默的：权限矩阵拿这个接口的结果当「已勾选的 id 集合」
（`perm-matrix.tsx` 的树是从**全量**菜单 `allMenus` 建的，这个接口只提供勾选态）。
返回空或者返回错的集合，界面上就是「这个角色什么都没勾」——
管理员看见空的、顺手保存一下，**就把这个角色的菜单真的清空了**。
显示 bug 变成数据丢失。

⚠️ 顺带记一条查证过、**不是 bug** 的事：MANAGER 的菜单树里「部门管理」/
「用户管理」的 `parent_id` 指向一个**不在返回集合里**的父菜单（父节点没被授权），
它们被提到了顶层。这看着像树坏了，其实无害 —— 前端只用 id 集合，
而且 `perm-matrix.tsx` 里专门有 `orphanIds(checked, idx)` 在处理这种情况。
所以这里**不断言树形结构**，只断言 id 集合。
"""

import asyncio

from sqlalchemy import text
from starlette.testclient import TestClient


def _query(sql: str, params: dict) -> list:
    """直接查库拿真相源 —— 断言不能拿接口自己的输出当期望值"""
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def go() -> list:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker.begin() as session:
                return [str(r[0]) for r in (await session.execute(text(sql), params)).all()]
        finally:
            await engine.dispose()

    return asyncio.run(go())


def _flat(nodes: list) -> set[str]:
    out: set[str] = set()
    for node in nodes:
        out.add(str(node['id']))
        out |= _flat(node.get('children') or [])
    return out


def test_role_menu_tree_matches_the_grant_table(client: TestClient, token_headers: dict[str, str]) -> None:
    """返回的 id 集合必须**正好等于** `sys_role_menu` 里那一批。

    🔴 期望值从**数据库**取，不从别的接口取 —— 拿接口对接口，
    两边一起错的时候测试照旧绿。
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    # 挑一个真的授权了菜单的角色：种子里 MANAGER 有 7 条
    checked = 0
    for role in roles:
        expected = set(
            _query(
                'SELECT menu_id FROM sys_role_menu WHERE role_id = :rid',
                {'rid': int(role['id'])},
            )
        )
        if not expected:
            continue
        checked += 1
        resp = client.get(f'/sys/roles/{role["id"]}/menus', headers=token_headers)
        assert resp.status_code == 200, resp.text
        got = _flat(resp.json()['data'] or [])
        assert got == expected, (
            f'{role["code"]} 的菜单集合对不上：接口给 {len(got)} 个、库里是 {len(expected)} 个\n'
            f'  多出来：{sorted(got - expected)[:5]}\n  少了：{sorted(expected - got)[:5]}'
        )

    # 🔴 先断言「有」：一个授权了菜单的角色都没挑到的话，上面整个循环空转
    assert checked >= 2, f'只核对了 {checked} 个角色，种子数据变了？这条证明不了什么'


def test_role_menu_tree_is_not_the_whole_menu_list(client: TestClient, token_headers: dict[str, str]) -> None:
    """不同角色要拿到不同的集合，而且都不是全量菜单。

    钉住两种最像「正常」的坏法：接口忘了按角色过滤（人人拿到全量 → 权限矩阵
    全勾上，保存一下就把所有菜单授权给这个角色），或者所有角色都返回同一批。
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    all_menus = _flat(client.get('/sys/menus', headers=token_headers).json()['data'] or [])
    assert len(all_menus) >= 20, f'全量菜单只有 {len(all_menus)} 个，种子可能没灌'

    sets = {}
    for role in roles:
        got = _flat(client.get(f'/sys/roles/{role["id"]}/menus', headers=token_headers).json()['data'] or [])
        assert got != all_menus, f'{role["code"]} 拿到了全量菜单 —— 按角色过滤没生效'
        assert got <= all_menus, f'{role["code"]} 的菜单里有不在全量里的：{sorted(got - all_menus)[:3]}'
        sets[role['code']] = got

    assert len({frozenset(v) for v in sets.values()}) >= 2, (
        f'所有角色拿到了同一批菜单：{ {k: len(v) for k, v in sets.items()} }'
    )


def test_user_roles_match_the_grant_table(client: TestClient, token_headers: dict[str, str]) -> None:
    """`GET /sys/users/{pk}/roles` 同理 —— 和 `sys_user_role` 对得上。

    这个接口是「用户详情页的角色下拉的初值」。返回空的表现是
    「这个用户看起来没有任何角色」，保存一下就真的没有了。
    """
    users = client.get('/sys/users', headers=token_headers, params={'page': 1, 'size': 20}).json()['data']['items']
    checked = 0
    for user in users:
        expected = set(_query('SELECT role_id FROM sys_user_role WHERE user_id = :uid', {'uid': int(user['id'])}))
        if not expected:
            continue
        checked += 1
        resp = client.get(f'/sys/users/{user["id"]}/roles', headers=token_headers)
        assert resp.status_code == 200, resp.text
        got = {str(r['id']) for r in (resp.json()['data'] or [])}
        assert got == expected, f'{user["username"]} 的角色集合对不上：接口 {sorted(got)} vs 库 {sorted(expected)}'
        if checked >= 3:
            break

    assert checked >= 2, f'只核对了 {checked} 个用户，这条证明不了什么'
