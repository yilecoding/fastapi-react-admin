"""分页不能被 m2m join 的扇出污染。

用户列表的查询里 join 了 `sys_user_role` + `sys_role`（为了在列表上直接显示
角色名）。m2m join 会让**一个挂 N 个角色的用户变成 N 行**，而分页的
`total` 和 `LIMIT` 都作用在 join 后的行上，去重（`select_join_serialize`）
发生在**分页之后** —— 于是：

- `total` 数的是 join 行数，不是用户数
- 每一页被落在这一页窗口里的重复行**偷走名额**，短一截

⚠️ 种子数据里每个用户恰好挂一个角色，所以这个 bug 在默认数据上
**永远不显形** —— 必须显式造一个多角色用户才测得出来。
"""

import pytest

from starlette.testclient import TestClient


@pytest.fixture
def multi_role_user(client: TestClient, token_headers: dict[str, str]):
    """建一个挂两个角色的用户，用完硬删。

    硬删的理由和 `tests/conftest.py` 的 `temp_user` 一样（逻辑删除会堆行），
    那边的注释是完整版。
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    assert len(roles) >= 2, f'种子里角色不够两个，没法造扇出：{len(roles)}'
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']

    res = client.post(
        '/sys/users',
        headers=token_headers,
        json={
            'username': 'pytest_fanout',
            'password': 'Tmp@123456',
            'nickname': '多角色用户',
            'dept_id': dept_id,
            'roles': [roles[0]['id'], roles[1]['id']],
        },
    )
    assert res.status_code == 200 and res.json()['code'] == 200, f'建多角色用户失败：{res.text}'
    pk = res.json()['data']['id']

    # 前置断言：确认这个用户真的挂上了两个角色 —— 否则下面两条测试会
    # 因为「没造出扇出」而假绿
    detail = client.get(f'/sys/users/{pk}', headers=token_headers).json()['data']
    assert len(detail['roles']) == 2, f'角色没挂上两个，扇出造不出来：{detail["roles"]}'

    yield pk

    import asyncio

    from sqlalchemy import text

    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def _purge() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker.begin() as session:
                await session.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': int(pk)})
                await session.execute(text('DELETE FROM sys_user WHERE id = :pk'), {'pk': int(pk)})
        finally:
            await engine.dispose()

    asyncio.run(_purge())


def test_total_counts_users_not_join_rows(
    client: TestClient, token_headers: dict[str, str], multi_role_user: int
) -> None:
    """`total` 数的必须是用户数，不是 join 出来的行数。

    实测（修之前）：一个挂两个角色的用户会让 `total` 比实际用户数多 1。
    界面上就是「共 22 条」而只列得出 20 条 —— 用户以为漏了数据。
    """
    d = client.get('/sys/users', headers=token_headers, params={'page': 1, 'size': 100}).json()['data']
    ids = [i['id'] for i in d['items']]
    assert len(ids) == len(set(ids)), f'同一个用户在一页里出现了多次：{len(ids)} 行 / {len(set(ids))} 人'
    assert d['total'] == len(set(ids)), (
        f'total={d["total"]} 但一页只列得出 {len(set(ids))} 个用户 —— join 扇出被算进了总数'
    )


def test_page_is_full_while_rows_remain(
    client: TestClient, token_headers: dict[str, str], multi_role_user: int
) -> None:
    """还有后续数据时，每一页必须装满。

    实测（修之前）：`size=20` 的第一页只回 18 条 —— `LIMIT 20` 取的是 join 行，
    落在窗口里的 2 个重复行去重后凭空少了 2 个名额。这个症状比 `total` 更难查：
    数量对不上，但每条数据本身都是对的。

    ⚠️ 断言写成「逐页翻完、每页都装满、加起来等于 total」这个不变式，
    而不是「第一页必须有 size 条」—— 后者取决于那个多角色用户的雪花 ID
    正好落在第几页（它比种子数据的 ID 小，排在最后），换台机器就测不到东西了。
    """
    size = 3
    total = client.get('/sys/users', headers=token_headers, params={'page': 1, 'size': size}).json()['data']['total']
    pages = (total + size - 1) // size
    assert pages >= 2, f'数据不够翻页，这条测不到东西（total={total}）'

    seen: list[str] = []
    for page in range(1, pages + 1):
        d = client.get('/sys/users', headers=token_headers, params={'page': page, 'size': size}).json()['data']
        expect = size if page < pages else total - size * (pages - 1)
        assert len(d['items']) == expect, (
            f'第 {page}/{pages} 页有 {len(d["items"])} 条，应该是 {expect} 条 —— 名额被重复行吃了'
        )
        seen.extend(str(i['id']) for i in d['items'])

    assert len(seen) == total, f'逐页翻完只拿到 {len(seen)} 条，total 说有 {total} 条'
    assert len(set(seen)) == total, f'翻页过程中有重复用户：{len(seen)} 条里只有 {len(set(seen))} 个不同的'


def test_role_filter_keeps_all_roles_of_the_user(
    client: TestClient, token_headers: dict[str, str], multi_role_user: int
) -> None:
    """按角色筛选时，每条结果的 `roles` 仍然是该用户的**全部**角色。

    修之前是「只有被筛的那一个」—— 因为筛选条件 `user_role.c.role_id == role`
    同时把 join 出来的角色行也筛掉了。源码里写着这个副作用，说要拿完整角色
    就去调 `GET /users/{pk}/roles`；换成子查询之后两个问题一起没了。
    """
    roles = client.get('/sys/roles/all', headers=token_headers).json()['data']
    d = client.get('/sys/users', headers=token_headers, params={'page': 1, 'size': 100, 'role': roles[0]['id']}).json()[
        'data'
    ]
    mine = [i for i in d['items'] if str(i['id']) == str(multi_role_user)]
    assert mine, '按角色筛选没筛出那个多角色用户'
    assert len(mine[0]['roles']) == 2, f'按角色筛选后 roles 被截断成 {len(mine[0]["roles"])} 个'

    # ⚠️ 上面两条断言在「子查询放行了全部用户」时也是绿的 —— 过滤本身要单独验。
    # 换成子查询之后筛选条件不再落在 join 出来的行上，容易漏。
    wanted = str(roles[0]['id'])
    for item in d['items']:
        assert wanted in {str(r['id']) for r in item['roles']}, (
            f'{item["username"]} 没有被筛的那个角色，却出现在结果里 —— 子查询没起作用'
        )
