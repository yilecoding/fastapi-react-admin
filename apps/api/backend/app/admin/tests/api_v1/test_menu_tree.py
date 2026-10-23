"""菜单树的结构约束：上级不能是自己，也不能是自己的下级（#143，同部门 #135 的 `test_dept_tree.py`）。

🔴 后者原来只有前端拦（菜单表单的上级下拉里排除了自己那棵子树），带 token 直接 `PUT` 就能把
A 挂到 A 的孙子下面 —— 成环之后那棵子树找不到根，从菜单树里整个消失，而库里每一行都还在。
AI 工具（`menu_tools.py`）的预演和执行走的也是 `menu_service.check_update` 这一份。
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
PREFIX = f'菜单树{RUN}'


async def _purge() -> None:
    engine = create_database_async_engine(get_database_url(unittest=True))
    try:
        async with engine.begin() as conn:
            await conn.execute(text('DELETE FROM sys_menu WHERE title LIKE :p'), {'p': f'{PREFIX}%'})
    finally:
        await engine.dispose()


def _body(key: str, parent_id: str | None) -> dict:
    return {
        'title': f'{PREFIX}{key}', 'name': f'PytestTree{RUN}{key}', 'path': f'/pytest-tree/{RUN.lower()}/{key}',
        'parent_id': parent_id, 'sort': 0, 'icon': None, 'type': 0, 'perms': None,
        'status': 1, 'display': 1, 'link': None, 'remark': None,
    }  # fmt: skip


def _find(nodes: list[dict], title: str) -> dict:
    for node in nodes:
        if node['title'] == title:
            return node
        found = _find(node.get('children') or [], title)
        if found:
            return found
    return {}


def _tree(client: TestClient, headers: dict[str, str]) -> list[dict]:
    return client.get(MENUS, headers=headers, params={'title': PREFIX}).json()['data']


@pytest.fixture
def chain(client: TestClient, token_headers: dict[str, str]) -> Iterator[dict[str, str]]:
    """A ── B ── C（三个目录，键 → ID）"""
    ids: dict[str, str] = {}
    try:
        parent = None
        for key in ('A', 'B', 'C'):
            res = client.post(MENUS, headers=token_headers, json=_body(key, parent)).json()
            assert res['code'] == 200, res
            ids[key] = parent = _find(_tree(client, token_headers), f'{PREFIX}{key}')['id']
        yield ids
    finally:
        asyncio.run(_purge())


def _move(client: TestClient, headers: dict[str, str], key: str, pk: str, parent_id: str | None) -> dict:
    return client.put(f'{MENUS}/{pk}', headers=headers, json=_body(key, parent_id)).json()


@pytest.mark.parametrize('target', ['B', 'C'])
def test_a_menu_cannot_move_under_its_own_descendant(
    client: TestClient, token_headers: dict[str, str], chain: dict[str, str], target: str
) -> None:
    res = _move(client, token_headers, 'A', chain['A'], chain[target])
    assert res['code'] == 403, res
    # 树还是原样：A 仍在顶层、C 仍在 A 的子树里
    a = _find(_tree(client, token_headers), f'{PREFIX}A')
    assert a and a['parent_id'] is None
    assert _find(a.get('children') or [], f'{PREFIX}C')


def test_moving_within_the_tree_still_works(
    client: TestClient, token_headers: dict[str, str], chain: dict[str, str]
) -> None:
    """对照：挪到不是自己下级的地方照常放行 —— 一个永远拒绝的实现也能让上面那条绿"""
    res = _move(client, token_headers, 'C', chain['C'], chain['A'])
    assert res['code'] == 200, res
    assert _find(_tree(client, token_headers), f'{PREFIX}C')['parent_id'] == chain['A']
