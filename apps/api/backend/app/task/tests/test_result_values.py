"""执行记录的 `result` 不一定是字符串（#417）

`task_result.result` 是 `PickleType`，celery 往里存什么就是什么：

- 失败的：DatabaseBackend 存的是 `{'exc_type': ..., 'exc_message': (...), 'exc_module': ...}` 这个字典
- 成功的：任务返回什么就是什么 —— 现有任务都返回 str，但谁写个 `return {'deleted': 3}` 就是字典

响应模型 `GetTaskResultDetail.result` 原来声明 `str | None`，碰到前两种就 `ResponseValidationError` → 500，
**列表只要一页里有一条真失败记录，整页打不开**。原来的测试造的失败行 `result` 都是字符串，所以一直没红；
#400 实测时真 worker 写了两条失败行进测试库，执行记录相关的 4 条测试才一起红。

这里按 celery 真实写入的样子造行（经 ORM，`PickleType` 自己序列化），断言列表 / 详情都 200、`result` 是给人看的字符串。

⚠️ 每次起独立引擎（复用全局测试引擎会撞 TestClient 的事件循环，task 分册「测试」一节）。
"""

import asyncio
import uuid

import pytest

from sqlalchemy import delete
from starlette.testclient import TestClient

from backend.app.task.model.result import TaskExtended
from backend.utils.timezone import timezone

PREFIX = 'pytest-result-values-'

#: celery 的 DatabaseBackend 给失败任务存的就是这个形状（`exception_to_python` 的反面，`prepare_exception`）
CELERY_FAILURE = {
    'exc_type': 'OperationalError',
    'exc_message': ('(psycopg.OperationalError) connection refused',),
    'exc_module': 'sqlalchemy.exc',
}

CASES = {
    'failure': ('FAILURE', CELERY_FAILURE, 'OperationalError: (psycopg.OperationalError) connection refused'),
    'failure-no-args': (
        'FAILURE',
        {'exc_type': 'NotRegistered', 'exc_message': (), 'exc_module': 'celery'},
        'NotRegistered',
    ),
    'failure-many-args': (
        'FAILURE',
        {'exc_type': 'KeyError', 'exc_message': ('a', 2), 'exc_module': 'builtins'},
        'KeyError: a, 2',
    ),
    'dict': ('SUCCESS', {'deleted': 3, 'note': '清理完成'}, '{"deleted": 3, "note": "清理完成"}'),
    'int': ('SUCCESS', 5, '5'),
    'str': ('SUCCESS', '已清理 3 条', '已清理 3 条'),
    'none': ('SUCCESS', None, None),
}


def _run(coro_fn):
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    async def go():
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine).begin() as session:
                return await coro_fn(session)
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture
def rows() -> dict[str, int]:
    """每种 `result` 造一行（经 ORM，和 celery 一样由 PickleType 序列化），返回 {用例名: 记录 id}"""
    tag = uuid.uuid4().hex[:8]
    now = timezone.now().replace(microsecond=0)

    async def seed(session):
        made = {}
        for key, (status, value, _) in CASES.items():
            row = TaskExtended(f'{PREFIX}{tag}-{key}')
            row.status = status
            row.result = value
            row.name = 'pytest.result_values'
            row.date_done = now
            session.add(row)
            await session.flush()
            made[key] = row.id
        return made

    async def purge(session):
        await session.execute(delete(TaskExtended).where(TaskExtended.task_id.like(f'{PREFIX}%')))

    _run(purge)
    yield _run(seed)
    _run(purge)


@pytest.mark.parametrize('key', list(CASES))
def test_detail_renders_any_stored_result_as_text(
    client: TestClient, token_headers: dict[str, str], rows: dict[str, int], key: str
) -> None:
    resp = client.get(f'/tasks/results/{rows[key]}', headers=token_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()['data']['result'] == CASES[key][2]


def test_a_page_with_real_failures_still_lists(
    client: TestClient, token_headers: dict[str, str], rows: dict[str, int]
) -> None:
    """🔴 这才是用户撞到的那个：一页里有一条真失败记录，整页 500"""
    resp = client.get('/tasks/results', params={'name': 'pytest.result_values', 'size': 50}, headers=token_headers)
    assert resp.status_code == 200, resp.text
    # id 下发成字符串（硬纪律 6：ID 一律不当数字），按字符串比
    got = {str(item['id']): item['result'] for item in resp.json()['data']['items']}
    assert got == {str(rows[key]): want for key, (_, _, want) in CASES.items()}
