"""#394 ①：`run_after_commit` 只认最外层的提交 / 回滚。

SQLAlchemy 2.0 的保存点（`begin_nested()`）释放和回滚也会派发 `after_commit` / `after_rollback`
（`SessionTransaction.commit`：`if self._parent is None or self.nested`）。不区分的话：

- 保存点里登记的钩子在保存点释放时就跑了 —— 外层还没提交，worker / 客户端读到的是提交前的状态；外层随后回滚也已经发出去
- 外层早先登记的钩子被一次保存点回滚整个丢掉

真库（测试库）上的 AsyncSession，钩子只往列表里记一笔；派出去的是协程，要等 `_background` 跑完再断言。
"""

import asyncio

from collections.abc import Awaitable, Callable

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

from backend.common import after_commit
from backend.common.after_commit import run_after_commit
from backend.tests.utils.db import async_test_db_session


def _recorder(fired: list[str], name: str) -> Callable[[], Awaitable[None]]:
    async def hook() -> None:
        await asyncio.sleep(0)
        fired.append(name)

    return hook


async def _settle() -> None:
    if after_commit._background:
        await asyncio.gather(*list(after_commit._background))


def _run(client: TestClient, scenario: Callable[[list[str]], object]) -> list[str]:
    fired: list[str] = []

    async def go() -> list[str]:
        await scenario(fired)  # type: ignore[misc]
        await _settle()
        return fired

    return client.portal.call(go)


def test_a_released_savepoint_does_not_fire_and_the_outer_rollback_cancels(client: TestClient) -> None:
    async def scenario(fired: list[str]) -> None:
        async with async_test_db_session() as db:
            await db.execute(text('SELECT 1'))
            async with db.begin_nested():
                run_after_commit(db, 'inner', _recorder(fired, 'inner'))
            await _settle()
            assert fired == [], '保存点释放时就派发了：外层还没提交'
            await db.rollback()

    assert _run(client, scenario) == [], '外层回滚了，保存点里登记的不该再做'


def test_a_released_savepoint_fires_once_on_the_outer_commit(client: TestClient) -> None:
    async def scenario(fired: list[str]) -> None:
        async with async_test_db_session() as db:
            await db.execute(text('SELECT 1'))
            async with db.begin_nested():
                run_after_commit(db, 'inner', _recorder(fired, 'inner'))
            await _settle()
            assert fired == []
            await db.commit()

    assert _run(client, scenario) == ['inner']


def test_a_savepoint_rollback_keeps_what_the_outer_transaction_registered(client: TestClient) -> None:
    async def scenario(fired: list[str]) -> None:
        async with async_test_db_session() as db:
            await db.execute(text('SELECT 1'))
            run_after_commit(db, 'outer', _recorder(fired, 'outer'))
            with pytest.raises(RuntimeError):
                async with db.begin_nested():
                    run_after_commit(db, 'inner', _recorder(fired, 'inner'))
                    raise RuntimeError('row failed')
            await db.commit()

    assert _run(client, scenario) == ['outer'], '保存点回滚只该丢它自己登记的'


def test_the_same_key_registered_outside_survives_an_inner_rollback(client: TestClient) -> None:
    """同一个 key 外层登记过、保存点里又登记一次：保存点回滚不能把外层那份带走"""

    async def scenario(fired: list[str]) -> None:
        async with async_test_db_session() as db:
            await db.execute(text('SELECT 1'))
            run_after_commit(db, 'kick', _recorder(fired, 'kick'))
            with pytest.raises(RuntimeError):
                async with db.begin_nested():
                    run_after_commit(db, 'kick', _recorder(fired, 'kick'))
                    raise RuntimeError('row failed')
            await db.commit()

    assert _run(client, scenario) == ['kick']


def test_nested_savepoints_promote_to_the_parent_and_die_with_it(client: TestClient) -> None:
    """内层释放 → 归到外层保存点；外层保存点回滚 → 一起丢"""

    async def scenario(fired: list[str]) -> None:
        async with async_test_db_session() as db:
            await db.execute(text('SELECT 1'))
            with pytest.raises(RuntimeError):
                async with db.begin_nested():
                    async with db.begin_nested():
                        run_after_commit(db, 'deep', _recorder(fired, 'deep'))
                    raise RuntimeError('outer savepoint failed')
            run_after_commit(db, 'top', _recorder(fired, 'top'))
            await db.commit()

    assert _run(client, scenario) == ['top']


def test_a_plain_commit_and_rollback_still_work(client: TestClient) -> None:
    async def scenario(fired: list[str]) -> None:
        async with async_test_db_session() as db:
            await db.execute(text('SELECT 1'))
            run_after_commit(db, 'a', _recorder(fired, 'rolled-back'))
            await db.rollback()
            await db.execute(text('SELECT 1'))
            run_after_commit(db, 'a', _recorder(fired, 'committed'))
            run_after_commit(db, 'a', _recorder(fired, 'committed'))
            await db.commit()

    assert _run(client, scenario) == ['committed']
