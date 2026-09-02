"""`maintenance.prune_logs` 的测试。

**这是全仓唯一一个会删数据的定时任务，而且是自动跑的。** 删错的后果不可逆，
而且没人会当场发现 —— 表现是三个月后有人问「上个月的登录记录呢」。

用同步引擎直接打 fba_test（这条路 `test_scheduler_timing.py` 已经趟过），
不走 celery：要验的是**删对了没有**，不是消息能不能送到 worker。
"""

import asyncio

from datetime import timedelta

import pytest

from sqlalchemy import create_engine, delete, func, select
from sqlalchemy.orm import sessionmaker

from backend.app.admin.model import LoginLog, OperaLog
from backend.app.task.celery import get_result_backend
from backend.core.conf import settings
from backend.utils.timezone import timezone

MARK = 'pytest-prune'

#: 显式给主键。`id_key` 的默认值是 `snowflake.generate`，而它要
#: `snowflake.init()`（要 Redis）—— 这组测试不需要 Redis，所以自己发号。
_next_id = iter(range(910000000000000001, 910000000000001000))


@pytest.fixture(scope='module')
def factory():
    url = (
        get_result_backend()
        .removeprefix('db+')
        .replace(f'/{settings.DATABASE_SCHEMA}?', f'/{settings.DATABASE_SCHEMA}_test?')
    )
    engine = create_engine(url, pool_pre_ping=True, future=True)
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def db(factory):
    def purge() -> None:
        with factory() as s:
            s.execute(delete(LoginLog).where(LoginLog.username == MARK))
            s.execute(delete(OperaLog).where(OperaLog.username == MARK))
            s.commit()

    purge()
    yield factory
    purge()


def seed_login(factory, *, days_ago: float, n: int = 1) -> None:
    """造 n 条 days_ago 天前的登录日志。

    ⚠️ `login_time` 和 `created_time` **显式给不同的值**：清理是按业务时间删的，
    如果实现悄悄改回 `created_time`，这两列不同才能把它区分出来。
    """
    at = timezone.now() - timedelta(days=days_ago)
    now = timezone.now()
    with factory() as s:
        for i in range(n):
            s.execute(
                LoginLog.__table__.insert().values(
                    id=next(_next_id),
                    user_uuid=f'{MARK}-{days_ago}-{i}',
                    username=MARK,
                    status=1,
                    ip='127.0.0.1',
                    os='t',
                    browser='t',
                    device='t',
                    msg='t',
                    login_time=at,
                    created_time=now,  # ← 故意错开
                )
            )
        s.commit()


def seed_opera(factory, *, days_ago: float, n: int = 1) -> None:
    at = timezone.now() - timedelta(days=days_ago)
    now = timezone.now()
    with factory() as s:
        for i in range(n):
            s.execute(
                OperaLog.__table__.insert().values(
                    id=next(_next_id),
                    trace_id=f'{MARK}-{days_ago}-{i}',
                    username=MARK,
                    method='GET',
                    title='t',
                    path='/t',
                    ip='127.0.0.1',
                    os='t',
                    browser='t',
                    device='t',
                    code='200',
                    status=1,
                    cost_time=1.0,
                    opera_time=at,
                    created_time=now,  # ← 故意错开
                )
            )
        s.commit()


def count(factory, model) -> int:
    with factory() as s:
        return s.execute(select(func.count()).select_from(model).where(model.username == MARK)).scalar_one()


def run_prune(**kw) -> str:
    """跑一次任务体，打 fba_test。

    两处都不能省，各自对应一个实测撞到的坑：

    🔴 **换会话。** 任务里 `async_db_session` 连的是 `DATABASE_SCHEMA`（开发库 fba），
    而测试数据造在 fba_test —— 不换的话任务在**开发库**上跑，报「清理 0 条」，
    看起来像逻辑不对，实际是删错了库。（更要紧的是反过来：它真的会去删开发库。）

    🔴 **每次起一个独立引擎，跑完就 dispose。** 不能复用
    `backend.tests.utils.db.async_test_engine` —— 那是模块级全局的，接口测试
    （TestClient）先跑时已经把连接池绑在它自己的事件循环上了；这里
    `asyncio.run` 再开一个循环，直接
    `got Future attached to a different loop`。单跑这个文件不会撞到，
    **只有全量跑才会** —— 又一条只在跑全量时才现形的问题。
    """
    import backend.app.task.tasks.maintenance.tasks as mod

    from backend.app.task.tasks.maintenance.tasks import prune_logs
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    engine = create_database_async_engine(get_database_url(unittest=True))
    session = create_database_async_session(engine)

    original = mod.async_db_session
    mod.async_db_session = session

    async def go() -> str:
        try:
            return await prune_logs(**kw)
        finally:
            await engine.dispose()

    try:
        return asyncio.run(go())
    finally:
        mod.async_db_session = original


# ── 删对了没有 ──────────────────────────────────────────────────────────────


def test_deletes_old_keeps_new(db):
    """🔴 最基本的一条：旧的删掉、新的留下。

    比较方向写反（`>` 写成 `<`）的后果是**把新日志删光、旧的全留着**，
    而任务照样报「成功，清理 N 条」。
    """
    seed_login(db, days_ago=40)
    seed_login(db, days_ago=1)
    seed_opera(db, days_ago=40)
    seed_opera(db, days_ago=1)
    assert count(db, LoginLog) == 2 and count(db, OperaLog) == 2

    run_prune(days=30)

    assert count(db, LoginLog) == 1, '旧的没删掉，或者把新的一起删了'
    assert count(db, OperaLog) == 1


def test_boundary_is_strictly_older_than(db):
    """边界：正好卡在 N 天的不删，比 N 天更早的才删。

    差一天的实现（`<=` 还是 `<`、cutoff 算错一天）在小数据量下看不出来，
    但它决定「保留 30 天」到底是 30 天还是 29 天。
    """
    seed_login(db, days_ago=29.9)  # 还没到 30 天
    seed_login(db, days_ago=30.1)  # 过了
    run_prune(days=30)
    assert count(db, LoginLog) == 1


def test_uses_business_time_not_created_time(db):
    """🔴 按 `login_time` / `opera_time` 删，不是 `created_time`。

    造数据时两列**故意错开**：业务时间是 40 天前，created_time 是刚刚。
    实现如果改回 `created_time`，这条会一条都删不掉。

    为什么这个区分重要：操作日志是后台消费者批量落库的，`created_time`
    滞后于 `opera_time`；而界面上那两页的筛选/排序/显示全用业务时间 ——
    按 created_time 清理，用户看到「30 天前」的还在、「29 天前」的没了。
    """
    seed_login(db, days_ago=40)
    seed_opera(db, days_ago=40)
    run_prune(days=30)
    assert count(db, LoginLog) == 0, '按 created_time 删了 —— 那两列在这条用例里是错开的'
    assert count(db, OperaLog) == 0


def test_returns_accurate_counts(db):
    """回执里的条数要准 —— 那是执行记录页上唯一能看到的「它干了什么」。"""
    seed_login(db, days_ago=40, n=3)
    seed_opera(db, days_ago=40, n=2)
    msg = run_prune(days=30)
    assert '登录日志 3 条' in msg, msg
    assert '操作日志 2 条' in msg, msg


def test_nothing_to_delete_is_not_an_error(db):
    """没有可删的也要正常返回 —— 幂等，第二次跑不该报错。"""
    seed_login(db, days_ago=1)
    assert '登录日志 0 条' in run_prune(days=30)
    assert count(db, LoginLog) == 1


# ── 分批 ────────────────────────────────────────────────────────────────────


def test_batches_until_drained(db):
    """🔴 分批必须**删干净**，不能只删一批就收工。

    循环写成 `if` 而不是 `while` 的话，一次只删 batch 条 —— 表面看任务
    天天在跑、日志也在减少，实际上永远追不上新增量，表还是无限长。

    ⚠️ **这条只验「删干净」，不验「分批了」。** 注释原来写的是
    「5 条数据 + batch=2 逼出至少三轮循环」—— 那句话不成立：代码完全不分批
    （一条无界 DELETE）时它照样绿（实测 79 条全绿）。机制本身由
    `test_deletes_in_batches_not_one_unbounded_statement` 盯着。
    """
    seed_login(db, days_ago=40, n=5)
    msg = run_prune(days=30, batch=2)
    assert count(db, LoginLog) == 0, '没删干净 —— 分批循环可能只跑了一轮'
    assert '登录日志 5 条' in msg, msg


def test_deletes_in_batches_not_one_unbounded_statement(db):
    """🔴 分批这件事**本身**必须发生，不只是「删干净」。

    实测：把整个 while 循环换成一条无界 `DELETE ... WHERE time_col < cutoff`，
    上面那条 `test_batches_until_drained`（名字就叫「分批」）**照旧绿** ——
    它验的是删干净，而一条 DELETE 也能删干净。全套 79 条一条都不红。

    要防的后果写在任务体的注释里：SQL Server 上单表累计约 5000 个行锁就
    **升级成表锁**，于是清理期间所有写操作日志的请求被阻塞 —— 而每个 API
    请求都写操作日志。表现是「凌晨三点整站卡住几分钟，而日志里只有一条
    任务成功」。那个后果在测试里造不出来，但**「发了几条 DELETE」造得出来**。

    ⚠️ 监听挂在 `Engine` 类上（对所有引擎生效），所以只在 `run_prune`
    前后那一小段挂着：造数据和事后计数走的是夹具自己的同步引擎，
    挂久了会把它们的 DELETE 也数进来。
    """
    from sqlalchemy import event
    from sqlalchemy.engine import Engine

    deletes: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany) -> None:
        if statement.lstrip().upper().startswith('DELETE'):
            deletes.append(statement)

    seed_login(db, days_ago=40, n=5)
    event.listen(Engine, 'before_cursor_execute', record)
    try:
        run_prune(days=30, batch=2)
    finally:
        event.remove(Engine, 'before_cursor_execute', record)

    assert count(db, LoginLog) == 0, '没删干净'
    # 5 条 / batch=2 → 三条 DELETE（2 + 2 + 1）。操作日志这边是 0 条，不发 DELETE
    assert len(deletes) >= 3, (
        f'只发了 {len(deletes)} 条 DELETE —— 分批没生效。一条无界 DELETE 也能把数据「删干净」，所以光看结果分辨不出来'
    )


# ── 任务执行记录的清理 ──────────────────────────────────────────────────────


def seed_result(factory, *, days_ago: float, n: int = 1) -> None:
    from backend.app.task.model import TaskExtended

    at = timezone.now() - timedelta(days=days_ago)
    with factory() as s:
        for i in range(n):
            s.execute(
                TaskExtended.__table__.insert().values(
                    task_id=f'{MARK}-{days_ago}-{i}',
                    status='SUCCESS',
                    name=MARK,
                    date_done=at,
                )
            )
        s.commit()


def count_results(factory) -> int:
    from backend.app.task.model import TaskExtended

    with factory() as s:
        return s.execute(select(func.count()).select_from(TaskExtended).where(TaskExtended.name == MARK)).scalar_one()


@pytest.fixture
def results_db(factory):
    from backend.app.task.model import TaskExtended

    def purge() -> None:
        with factory() as s:
            s.execute(delete(TaskExtended.__table__).where(TaskExtended.name == MARK))
            s.commit()

    purge()
    yield factory
    purge()


def run_prune_results(**kw) -> str:
    import backend.app.task.tasks.maintenance.tasks as mod

    from backend.app.task.tasks.maintenance.tasks import prune_task_results
    from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url

    engine = create_database_async_engine(get_database_url(unittest=True))
    original = mod.async_db_session
    mod.async_db_session = create_database_async_session(engine)

    async def go() -> str:
        try:
            return await prune_task_results(**kw)
        finally:
            await engine.dispose()

    try:
        return asyncio.run(go())
    finally:
        mod.async_db_session = original


def test_prunes_old_task_results(results_db):
    """🔴 执行记录不清理会无限长。

    celery 自带的 `backend_cleanup` 装不上（`DatabaseScheduler.setup_schedule()`
    重写掉了 `install_default_entries()`），而 `get_registered_tasks()` 又把
    `celery.*` 过滤掉了 —— 界面上也排不了它。于是每执行一次任务多一行，
    一个每分钟跑的调度一年写 52 万行，而这张表正是「执行记录」页翻的那张。
    """
    seed_result(results_db, days_ago=40, n=3)
    seed_result(results_db, days_ago=1)
    assert count_results(results_db) == 4

    msg = run_prune_results(days=30)
    assert count_results(results_db) == 1, '旧记录没删掉，或者把新的一起删了'
    assert '3 条' in msg, msg


def test_prune_results_batches_until_drained(results_db):
    """同 prune_logs：分批要删干净，不能只跑一轮。"""
    seed_result(results_db, days_ago=40, n=5)
    run_prune_results(days=30, batch=2)
    assert count_results(results_db) == 0
