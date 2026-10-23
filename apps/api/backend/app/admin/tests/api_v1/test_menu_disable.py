"""停用一个目录 = 连同整棵下级一起关掉（#143）。

原来权限码只看菜单**自己**的状态，侧边栏只跳过「不显示」的、不看状态 —— 而目录 / 页面大多不带权限码，
停用它们之后侧边栏照常显示、下面按钮的权限照常生效，接口返回 200、界面说「保存成功」，什么都没变。

这里走真实接口、用一个非超管账号断言三处一起变：`/auth/codes`、侧边栏、带权限码的接口（`rbac_verify`）。
它们读的是同一份用户快照（`get_jwt_user` 里按上级算过状态），所以还要断言**改完马上**生效 ——
快照没跟着清的话，那个人要等 token 过期才失去权限。超管那一支（`/auth/codes` 直接查库）另断言一遍。
"""

import asyncio
import uuid

from collections.abc import Iterator
from typing import Any

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, get_database_url

MENUS = '/sys/menus'
ROLES = '/sys/roles'
RUN = uuid.uuid4().hex[:6].upper()
PREFIX = f'停用测试{RUN}'
ROLE_PREFIX = f'PYOFF{RUN}'
# 两个按钮：一个用独有的码（超管的 `/auth/codes` 里也只有它这一处来源），一个借用真实接口的码（验 `rbac_verify`）
OWN_PERM = f'pytest:off:{RUN.lower()}'
API_PERM = 'log:login:list'
API = '/logs/login'


async def _purge() -> None:
    """硬删。🔴 删角色的接口是软删，`sys_user_role` 里 sunqiang 和这些角色的关联行会留下 ——
    `test_role_menu_tree.py` 拿接口和这张表对账，留着它就红"""
    engine = create_database_async_engine(get_database_url(unittest=True))
    try:
        async with engine.begin() as conn:
            roles = 'SELECT id FROM sys_role WHERE code LIKE :r'
            menus = 'SELECT id FROM sys_menu WHERE title LIKE :p'
            args = {'r': f'{ROLE_PREFIX}%', 'p': f'{PREFIX}%'}
            await conn.execute(text(f'DELETE FROM sys_user_role WHERE role_id IN ({roles})'), args)
            await conn.execute(
                text(f'DELETE FROM sys_role_menu WHERE role_id IN ({roles}) OR menu_id IN ({menus})'), args
            )
            await conn.execute(text('DELETE FROM sys_role WHERE code LIKE :r'), args)
            await conn.execute(text('DELETE FROM sys_menu WHERE title LIKE :p'), args)
    finally:
        await engine.dispose()


def _body(key: str, *, type: int, parent_id: str | None, perms: str | None = None, status: int = 1) -> dict:
    return {
        'title': f'{PREFIX}{key}', 'name': f'PytestOff{RUN}{key}',
        'path': None if type == 2 else f'/pytest-off/{RUN.lower()}/{key}',
        'parent_id': parent_id, 'sort': 0, 'icon': None, 'type': type, 'perms': perms,
        'status': status, 'display': 0 if type == 2 else 1, 'link': None, 'remark': None,
    }  # fmt: skip


def _find(nodes: list[dict], pk: str) -> dict:
    for node in nodes:
        if str(node['id']) == pk:
            return node
        found = _find(node.get('children') or [], pk)
        if found:
            return found
    return {}


def _staff(client: TestClient) -> dict[str, str]:
    body = client.post('/auth/login/swagger', params={'username': 'sunqiang', 'password': '123456'}).json()
    return {'Authorization': f'{body["token_type"]} {body["access_token"]}'}


def _state(client: TestClient, headers: dict[str, str], ids: dict[str, str]) -> dict[str, Any]:
    sidebar = client.get(f'{MENUS}/sidebar', headers=headers).json()['data']
    return {
        'codes': set(client.get('/auth/codes', headers=headers).json()['data']),
        'folder': bool(_find(sidebar, ids['folder'])),
        'page': bool(_find(sidebar, ids['page'])),
        'api': client.get(API, headers=headers).status_code,
    }


@pytest.fixture(params=['whole-tree', 'without-folder'])
def granted(
    request: pytest.FixtureRequest, client: TestClient, token_headers: dict[str, str]
) -> Iterator[dict[str, str]]:
    """目录 ── 页面 ── 两个按钮，授给一个新角色，角色里放种子里的普通员工 sunqiang

    `without-folder`：角色只有页面和按钮、没有目录（接口允许这么授）。停用目录时要清的是**持有下级**的人的快照 ——
    只清「持有这个目录的人」的话，这种角色下的人权限照旧，直到 token 过期
    """
    code = f'{ROLE_PREFIX}{uuid.uuid4().hex[:4].upper()}'
    role_id = staff_id = None
    try:
        before = set(client.get('/auth/codes', headers=_staff(client)).json()['data'])
        assert API_PERM not in before, f'前置：sunqiang 原本不能有 {API_PERM}，否则停用之后照样 200'

        ids: dict[str, str] = {}
        for key, kwargs in (
            ('folder', {'type': 0, 'parent_id': None}),
            ('page', {'type': 1, 'parent_id': 'folder'}),
            ('own', {'type': 2, 'parent_id': 'page', 'perms': OWN_PERM}),
            ('api', {'type': 2, 'parent_id': 'page', 'perms': API_PERM}),
        ):
            kwargs['parent_id'] = ids.get(kwargs['parent_id'])
            res = client.post(MENUS, headers=token_headers, json=_body(key, **kwargs)).json()
            assert res['code'] == 200, res
            tree = client.get(MENUS, headers=token_headers, params={'title': f'{PREFIX}{key}'}).json()['data']
            ids[key] = next(str(n['id']) for n in tree if n['title'] == f'{PREFIX}{key}')

        res = client.post(ROLES, headers=token_headers, json={'name': code, 'code': code, 'status': 1, 'remark': None})
        assert res.json()['code'] == 200, res.text
        role_id = client.get(ROLES, headers=token_headers, params={'code': code}).json()['data']['items'][0]['id']
        users = client.get('/sys/users', headers=token_headers, params={'username': 'sunqiang'}).json()['data']
        staff_id = users['items'][0]['id']
        res = client.post(f'{ROLES}/{role_id}/users', headers=token_headers, json={'users': [staff_id]})
        assert res.json()['code'] == 200, res.text
        menus = [pk for key, pk in ids.items() if key != 'folder' or request.param == 'whole-tree']
        res = client.put(f'{ROLES}/{role_id}/menus', headers=token_headers, json={'menus': menus})
        assert res.json()['code'] == 200, res.text
        yield {**ids, 'grant': request.param}
    finally:
        # 先走接口把人移出角色：那一步会清 sunqiang 的用户快照，只在库里硬删的话快照里还挂着这个角色
        if role_id and staff_id:
            client.request('DELETE', f'{ROLES}/{role_id}/users', headers=token_headers, json={'users': [staff_id]})
        if role_id:
            client.request('DELETE', ROLES, headers=token_headers, json={'pks': [role_id]})
        asyncio.run(_purge())


def _set_folder(client: TestClient, headers: dict[str, str], ids: dict[str, str], status: int) -> None:
    res = client.put(
        f'{MENUS}/{ids["folder"]}', headers=headers, json=_body('folder', type=0, parent_id=None, status=status)
    )
    assert res.json()['code'] == 200, res.text


def test_disabling_a_folder_turns_off_its_whole_subtree(
    client: TestClient, token_headers: dict[str, str], granted: dict[str, str]
) -> None:
    staff = _staff(client)
    # 先断言「有」：授权之后整棵都生效
    on = _state(client, staff, granted)
    assert {OWN_PERM, API_PERM} <= on['codes'], on
    assert (on['folder'], on['page'], on['api']) == (granted['grant'] == 'whole-tree', True, 200), on

    _set_folder(client, token_headers, granted, 0)
    # 同一个 token，不重新登录：用户快照要跟着清，不能等 token 过期
    off = _state(client, staff, granted)
    assert not {OWN_PERM, API_PERM} & off['codes'], f'停用目录之后下面按钮的权限码还在：{off["codes"]}'
    assert (off['folder'], off['page']) == (False, False), '停用的目录 / 它下面的页面还在侧边栏里'
    assert off['api'] == 403, f'停用目录之后带 {API_PERM} 的接口照样能调'

    # 超管：`/auth/codes` 那一支直接查库，侧边栏也一样不显示
    admin = _state(client, token_headers, granted)
    assert OWN_PERM not in admin['codes'] and not admin['folder'], admin


def test_re_enabling_brings_the_subtree_back(
    client: TestClient, token_headers: dict[str, str], granted: dict[str, str]
) -> None:
    """停用只写目录自己那一行，下级是「按上级算」不生效 —— 重新启用目录，整棵原样回来"""
    staff = _staff(client)
    _set_folder(client, token_headers, granted, 0)
    assert _state(client, staff, granted)['api'] == 403
    _set_folder(client, token_headers, granted, 1)
    back = _state(client, staff, granted)
    assert {OWN_PERM, API_PERM} <= back['codes'], back
    assert (back['folder'], back['page'], back['api']) == (granted['grant'] == 'whole-tree', True, 200), back
