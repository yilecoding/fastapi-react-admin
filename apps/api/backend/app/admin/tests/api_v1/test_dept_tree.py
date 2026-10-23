"""部门树的结构约束：上级不能是自己，也不能是自己的下级。

🔴 后者原来只有前端拦（上级部门的下拉里排除了自己那棵子树），接口直接 `PUT` 就能把
A 挂到 A 的孙子下面 —— 成环之后 A 和它整棵子树从部门树里一起消失（`get_tree_data`
找不到根），而库里每一行都还在、每个用户的 `dept_id` 也都对，看起来像数据丢了。
部门导入的「只更新 / 新增并更新」模式能一次改很多行的上级，这条路比表单更容易踩到。
"""

import asyncio
import uuid

from collections.abc import Iterator

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.database.db import create_database_async_engine, get_database_url

DEPTS = '/sys/depts'
RUN = uuid.uuid4().hex[:6].upper()


async def _purge() -> None:
    engine = create_database_async_engine(get_database_url(unittest=True))
    try:
        async with engine.begin() as conn:
            await conn.execute(text('DELETE FROM sys_dept WHERE code LIKE :p'), {'p': f'TREE{RUN}%'})
    finally:
        await engine.dispose()


@pytest.fixture
def chain(client: TestClient, token_headers: dict[str, str]) -> Iterator[dict[str, str]]:
    """A ── B ── C（编码 → ID）"""
    ids: dict[str, str] = {}
    try:
        parent = None
        for key in ('A', 'B', 'C'):
            body = {'code': f'TREE{RUN}{key}', 'name': f'树{RUN}{key}', 'parent_id': parent, 'status': 1}
            res = client.post(DEPTS, headers=token_headers, json=body).json()
            assert res['code'] == 200, res
            listed = client.get(DEPTS, headers=token_headers, params={'code': body['code']}).json()['data']
            ids[key] = parent = _find(listed, body['code'])['id']
        yield ids
    finally:
        asyncio.run(_purge())


def _find(nodes: list[dict], code: str) -> dict:
    for node in nodes:
        if node['code'] == code:
            return node
        found = _find(node.get('children') or [], code)
        if found:
            return found
    return {}


def _move(client: TestClient, headers: dict[str, str], pk: str, name: str, parent_id: str | None) -> dict:
    body = {'name': name, 'parent_id': parent_id, 'status': 1}
    return client.put(f'{DEPTS}/{pk}', headers=headers, json=body).json()


@pytest.mark.parametrize('target', ['B', 'C'])
def test_a_department_cannot_move_under_its_own_descendant(
    client: TestClient, token_headers: dict[str, str], chain: dict[str, str], target: str
) -> None:
    res = _move(client, token_headers, chain['A'], f'树{RUN}A', chain[target])
    assert res['code'] == 403, res
    # 树还是原样：A 仍在顶层、C 仍在 B 下面
    tree = client.get(DEPTS, headers=token_headers, params={'code': f'TREE{RUN}'}).json()['data']
    a = _find(tree, f'TREE{RUN}A')
    assert a and a['parent_id'] is None
    assert _find(a.get('children') or [], f'TREE{RUN}C')


def test_moving_within_the_tree_still_works(
    client: TestClient, token_headers: dict[str, str], chain: dict[str, str]
) -> None:
    """对照：挪到不是自己下级的地方照常放行 —— 一个永远拒绝的实现也能让上面那条绿"""
    res = _move(client, token_headers, chain['C'], f'树{RUN}C', chain['A'])
    assert res['code'] == 200, res
    tree = client.get(DEPTS, headers=token_headers, params={'code': f'TREE{RUN}'}).json()['data']
    assert _find(tree, f'TREE{RUN}C')['parent_id'] == chain['A']
