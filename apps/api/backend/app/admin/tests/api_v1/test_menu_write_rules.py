"""菜单「按类型必填」的规则，后端也要拦（`schema/menu.py: MenuWriteParam`）。

原来只在前端（`pages/menu/form.tsx` 的 superRefine）：带 token 直接打接口、或者让 AI 建菜单，
都能建出没有路由地址的菜单（侧边栏静默跳过它）、没有权限码的按钮（勾给谁都等于没给）。
"""

import asyncio
import uuid

from collections.abc import Iterator

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, get_database_url

MENUS = '/sys/menus'
RUN = uuid.uuid4().hex[:6].upper()


def _purge() -> None:
    async def go() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with engine.begin() as conn:
                # 名称非法那条用例的 name 也带着 RUN：校验被打掉时（变异检验）它真会建出来一行，得清得到
                await conn.execute(text('DELETE FROM sys_menu WHERE title LIKE :p'), {'p': f'规则测试{RUN}%'})
        finally:
            await engine.dispose()

    asyncio.run(go())


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    try:
        yield
    finally:
        _purge()


def _body(**overrides: object) -> dict:
    body = {
        'title': f'规则测试{RUN}', 'name': f'PytestRule{RUN}', 'path': f'/pytest-rule/{RUN.lower()}',
        'parent_id': None, 'sort': 0, 'icon': None, 'type': 1, 'perms': None,
        'status': 1, 'display': 1, 'link': None, 'remark': None,
    }  # fmt: skip
    return {**body, **overrides}


def test_a_valid_menu_still_goes_through(client: TestClient, token_headers: dict[str, str]) -> None:
    """对照：合法的照常建得出来 —— 一个永远 422 的实现也能让下面那组绿"""
    res = client.post(MENUS, headers=token_headers, json=_body())
    assert res.json()['code'] == 200, res.json()


@pytest.mark.parametrize(
    ('overrides', 'expect'),
    [
        ({'path': None}, '请填写路由地址'),
        ({'type': 2, 'path': None, 'perms': ' '}, '按钮必须填写权限标识'),
        ({'type': 4, 'link': ''}, '外链 / 内嵌必须填写地址'),
        ({'name': f'pytest-rule-{RUN}'}, '菜单名称须为英文'),
    ],
    ids=['menu-without-path', 'button-without-perms', 'link-without-url', 'name-not-a-route-name'],
)
def test_menus_missing_what_their_type_needs_are_rejected(
    client: TestClient, token_headers: dict[str, str], overrides: dict, expect: str
) -> None:
    title = f'规则测试{RUN}{uuid.uuid4().hex[:4]}'
    res = client.post(MENUS, headers=token_headers, json=_body(title=title, **overrides))
    assert res.status_code == 422, res.text
    assert expect in res.json()['msg'], res.json()
