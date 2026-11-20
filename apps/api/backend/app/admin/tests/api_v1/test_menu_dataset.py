"""侧边栏、菜单树、超管权限码改读进程内的菜单缓存（`menu_dataset`）之后，行为要和查库时一致。"""

import asyncio

from collections.abc import Generator
from types import SimpleNamespace

import pytest

from fastapi.testclient import TestClient
from sqlalchemy import delete

from backend.app.admin.crud.crud_menu import menu_dataset
from backend.app.admin.model import Menu
from backend.app.admin.service.menu_service import menu_service
from backend.common.enums import StatusType
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

MENUS = '/sys/menus'  # client 的 base_url 已经带了 /api/v1


def _user(*, superuser: bool, roles: list) -> SimpleNamespace:
    return SimpleNamespace(user=SimpleNamespace(is_superuser=superuser, roles=roles))


def _with_db(fn):
    """独立引擎跑一段 service 代码（共享的测试会话绑在 TestClient 的循环上，见 tests 分册）"""

    async def run():
        engine = create_database_async_engine(get_database_url(unittest=True))
        maker = create_database_async_session(engine)
        try:
            async with maker() as db:
                return await fn(db)
        finally:
            await engine.dispose()

    return asyncio.run(run())


def test_roles_without_menus_get_an_empty_sidebar() -> None:
    """🔴 原来角色都没挂菜单时不加过滤，返回的是整张侧边栏"""
    request = _user(superuser=False, roles=[SimpleNamespace(status=StatusType.enable, menus=[])])
    # 前置：这张表里确实有能下发的菜单，否则「空」在过滤失效时也成立
    assert _with_db(lambda db: menu_service.get_sidebar(db=db, request=_user(superuser=True, roles=[])))
    assert _with_db(lambda db: menu_service.get_sidebar(db=db, request=request)) == []


def test_a_non_superuser_only_sees_their_own_menus() -> None:
    async def scenario(db):
        snapshot = await menu_dataset.get(db)
        page = next(r for r in snapshot.rows if r['type'] == 1 and r['id'] not in snapshot.disabled)
        request = _user(
            superuser=False, roles=[SimpleNamespace(status=StatusType.enable, menus=[SimpleNamespace(id=page['id'])])]
        )
        return page, await menu_service.get_sidebar(db=db, request=request)

    menu_dataset.invalidate_now()
    page, sidebar = _with_db(scenario)
    assert [node['id'] for node in sidebar] == [str(page['id'])]


@pytest.fixture
def no_leftover_menu() -> Generator[None, None, None]:
    """前后都硬删：接口的删除是逻辑删除，而用例中途红了根本走不到删除那一步（tests 分册「清理不能写在最后一行」）"""

    async def purge(db) -> None:
        await db.execute(delete(Menu).where(Menu.name == 'PytestDatasetMenu'))
        await db.commit()

    _with_db(purge)
    yield
    _with_db(purge)


@pytest.mark.usefixtures('no_leftover_menu')
def test_the_sidebar_follows_a_create_and_delete_right_away(client: TestClient, token_headers: dict[str, str]) -> None:
    """同一进程里改完菜单，下一次取侧边栏就是新的（提交后失效），不用等 TTL"""

    def names() -> set[str]:
        resp = client.get(f'{MENUS}/sidebar', headers=token_headers).json()
        assert resp['code'] == 200, resp
        nodes = resp['data']
        out: set[str] = set()
        stack = list(nodes)
        while stack:
            node = stack.pop()
            out.add(node['name'])
            stack.extend(node.get('children') or [])
        return out

    before = names()  # 先读一次，让缓存热起来
    body = {
        'title': 'pytest-缓存菜单',
        'name': 'PytestDatasetMenu',
        'path': '/pytest-dataset-menu',
        'type': 0,
        'sort': 999,
        'status': 1,
        'display': 1,
        'cache': 1,
    }
    created_resp = client.post(MENUS, headers=token_headers, json=body).json()
    assert created_resp['code'] == 200, created_resp
    assert 'PytestDatasetMenu' in names(), '新建之后缓存没清，侧边栏还是旧的'

    tree = client.get(MENUS, headers=token_headers).json()['data']
    created = next(node for node in tree if node['name'] == 'PytestDatasetMenu')
    assert client.delete(f'{MENUS}/{created["id"]}', headers=token_headers).json()['code'] == 200
    assert names() == before, '删除之后缓存没清，侧边栏还是旧的'
