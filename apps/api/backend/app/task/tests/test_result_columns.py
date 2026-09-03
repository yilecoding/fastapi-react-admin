"""任务执行记录**详情**端点必须带上 `TaskExtended` 独有的那几列。

🔴 **`Task` 和 `TaskExtended` 是同一张表**（`__tablename__` 都是 `task_result`），
而 `name` / `worker` / `retries` / `queue` / `args` / `kwargs` 六列只声明在
`TaskExtended` 上。CRUD 绑成 `Task` 的话查询只 select 前一半的列 ——
接口 200、条数对、时间和状态都对，只有那几列是 null，界面上显示 `—`。

**列表端点这一面已经有人盯着了**：`test_scheduler_api.py::test_result_fields_are_extended`
连同三条时间范围测试，一共 4 条。把 CRUD 绑成 `Task` 那 4 条一起红（实测）。

⚠️ **缺的是详情端点**：`GET /tasks/results/{pk}` 走 `crud.get()`，那是**单独覆盖**
过的方法（`crud_scheduler.py` 里那条注释说的就是它），而实测**没有任何测试
打过这个端点**。列表对了不代表详情也对。

顺带记一条这次量出来的事：`scheduler.spec.ts` 里那条 E2E 断言**从来没跑过**。

    const first = page.locator('[data-testid^="open-result-"]').first()
    if ((await first.count()) === 0) {
      test.skip(true, "fba_test 里还没有执行记录（需要跑过一次 worker）")

`fba_test` 的 `task_result` 实测是 **0 行**（种子里只有 `task_scheduler`；
执行记录是 celery 写的，没有创建接口，`global-setup.ts` 只能走 HTTP 造数据）。
于是它永远走进 `test.skip`，而跳过在报告里长得像通过。
好在它守的那件事 pytest 这边覆盖着 —— 这条注释就是为了让下一个人知道
「那条 E2E 是休眠的，真正的覆盖在这里」。
"""

import asyncio

import pytest

from sqlalchemy import text
from starlette.testclient import TestClient

#: ⚠️ **不能自己指定 id** —— `task_result.id` 是 `autoincrement=True`，
#: 在 SQL Server 上就是 IDENTITY 列，显式给值直接
#: `Cannot insert explicit value for identity column ... IDENTITY_INSERT is set to OFF`。
#: 这张表和别的表不一样（其余表都是雪花 ID、自己发号），所以插完读回来。
TASK_ID = 'pytest-result-columns'
EXPECTED = {'name': 'maintenance.prune_logs', 'worker': 'pytest-worker', 'retries': 2, 'queue': 'pytest-queue'}


def _run(sql: str, params: dict, *, fetch: bool = False):
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def go():
        engine = create_database_async_engine(get_database_url(unittest=True))
        session_maker = create_database_async_session(engine)
        try:
            async with session_maker.begin() as session:
                result = await session.execute(text(sql), params)
                return result.scalar() if fetch else None
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def seeded_result():
    """造一行执行记录，收尾删掉。

    ⚠️ 收尾放 teardown 不放测试体末尾 —— 断言红了它照样跑
    （这条纪律在 `backend/tests/AGENTS.md` 里，我自己违反过两次）。

    ⚠️ 只给非空列 + 那六列里的四列：`result` / `args` / `kwargs` / `traceback`
    是 PickleType / LargeBinary，留 NULL 就行，测试要验的是「列有没有被 select」，
    不是能不能反序列化。
    """
    _run('DELETE FROM task_result WHERE task_id = :tid', {'tid': TASK_ID})
    _run(
        'INSERT INTO task_result (task_id, status, name, worker, retries, queue, date_done) '
        'VALUES (:tid, :st, :name, :worker, :retries, :queue, :done)',
        {
            'tid': TASK_ID,
            'st': 'SUCCESS',
            'name': EXPECTED['name'],
            'worker': EXPECTED['worker'],
            'retries': EXPECTED['retries'],
            'queue': EXPECTED['queue'],
            'done': '2026-09-03 08:00:00',
        },
    )
    row_id = _run('SELECT id FROM task_result WHERE task_id = :tid', {'tid': TASK_ID}, fetch=True)
    assert row_id is not None, '插进去了却读不回 id'
    yield row_id
    _run('DELETE FROM task_result WHERE task_id = :tid', {'tid': TASK_ID})


def test_detail_returns_the_extended_columns(
    client: TestClient, token_headers: dict[str, str], seeded_result: int
) -> None:
    """详情接口同理 —— 它和列表走的是不同的 CRUD 方法，要分开测。

    `get()` 是单独覆盖过的（`crud_scheduler.py` 里那条注释说的就是它），
    列表对了不代表详情也对。
    """
    resp = client.get(f'/tasks/results/{seeded_result}', headers=token_headers)
    assert resp.status_code == 200, resp.text
    row = resp.json()['data']
    for key, want in EXPECTED.items():
        assert row.get(key) == want, f'详情的 {key} 是 {row.get(key)!r}，应该是 {want!r}'
