"""`app/admin/tests` 下共用的 fixture。

⚠️ **放在 `tests/` 这一层，不是 `tests/api_v1/`** —— conftest 的 fixture 只对
**它所在目录树**可见。`temp_user` 一开始放在 `api_v1/conftest.py`，
`security/` 下的测试就 `fixture 'temp_user' not found`（实测踩到）。
两边都要用的东西放它们的共同父目录。

`temp_user` 原来在 `api_v1/test_admin_writes.py` 里，现在三个文件都要用 ——
提上来而不是复制：那个 fixture 里装着两条实测出来的注意事项
（ID 不能硬编码 / 收尾必须硬删），复制会让它们分叉。
"""

import pytest

from starlette.testclient import TestClient


@pytest.fixture
def temp_user(client: TestClient, token_headers: dict[str, str]):
    """建一个临时用户，用完删掉。

    ⚠️ 部门和角色 ID 从**接口**读，不硬编码 —— 三个方言的种子各有一套 ID
    （postgresql 的角色在 `4000000000000000xxx`、另两个在 `3000000000000000xxx`），
    写死会让这个测试只在一种库上能跑。
    """
    dept_id = client.get('/sys/depts', headers=token_headers).json()['data'][0]['id']
    role_id = client.get('/sys/roles/all', headers=token_headers).json()['data'][0]['id']

    username = 'pytest_tmp_writes'
    res = client.post(
        '/sys/users',
        headers=token_headers,
        json={
            'username': username,
            'password': 'Tmp@123456',
            'nickname': '临时用户',
            'dept_id': dept_id,
            'roles': [role_id],
        },
    )
    assert res.status_code == 200 and res.json()['code'] == 200, f'建临时用户失败：{res.text}'
    pk = res.json()['data']['id']
    yield pk

    # 🔴 **收尾必须硬删，不能只调 `DELETE /sys/users/{pk}`。**
    #
    # 那个接口是**逻辑删除**：`LogicalDeleteMixin` 把 `deleted` 从 0 改成行自己的
    # id（「0：否；id：是」），行永久留在表里 —— 用户名的唯一约束带着 `deleted`，
    # 所以同名还能再建、测试照样绿。代价是**每跑一次 pytest 就往 `fba_test` 里
    # 堆两行**（实测跑几轮就积了 10 行），而且没有任何现象。
    #
    # ⚠️ **不能复用共享的 `async_test_db_session`** —— 它已经被 `conftest.py` 的
    # 依赖覆盖绑到 TestClient 自己的事件循环上了，这里的 `asyncio.run()` 是另起
    # 一个循环，用它会 `attached to a different loop`。每次新建一个独立引擎，
    # 和 `security/test_user_cache_invalidation.py` 是同一个套路。
    import asyncio

    from sqlalchemy import text

    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def _purge() -> None:
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker.begin() as session:
                # 连带关联行，否则留下孤儿 sys_user_role
                await session.execute(text('DELETE FROM sys_user_role WHERE user_id = :pk'), {'pk': int(pk)})
                await session.execute(text('DELETE FROM sys_user WHERE id = :pk'), {'pk': int(pk)})
        finally:
            await engine.dispose()

    asyncio.run(_purge())
