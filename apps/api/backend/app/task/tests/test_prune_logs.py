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
from backend.tests.utils.db import sync_test_db_url
from backend.utils.timezone import timezone

MARK = 'pytest-prune'

#: 显式给主键。`id_key` 的默认值是 `snowflake.generate`，而它要
#: `snowflake.init()`（要 Redis）—— 这组测试不需要 Redis，所以自己发号。
_next_id = iter(range(910000000000000001, 910000000000001000))


@pytest.fixture(scope='module')
def factory():
    url = sync_test_db_url()
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


# ── 默认保留期：网络安全法的六个月（#261）────────────────────────────────────


def test_default_retention_keeps_six_months(db):
    """调度上没写 `days` 时按 180 天删：170 天前的留着，190 天前的删掉。

    原来默认 30 天 —— 低于网络安全法第二十一条「网络日志留存不少于六个月」，而且没写在任何地方。
    """
    seed_login(db, days_ago=170)
    seed_login(db, days_ago=190)
    seed_opera(db, days_ago=170)
    seed_opera(db, days_ago=190)

    msg = run_prune()

    assert '清理 180 天前的日志' in msg, msg
    assert count(db, LoginLog) == 1, '默认保留期不是 180 天'
    assert count(db, OperaLog) == 1


def _load_retention_migration():
    """按文件加载迁移模块（文件名以日期开头、带中文，不能 import）"""
    import importlib.util

    from backend.core.path_conf import BASE_PATH

    (path,) = (BASE_PATH / 'alembic' / 'versions').glob('*-ap000000logretention_*.py')
    spec = importlib.util.spec_from_file_location('ap000000logretention', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_default_retention_agrees_everywhere_and_meets_the_six_month_floor():
    """180 写在四处：任务默认值、三份种子的调度参数、给已装的库改值的迁移。任何一处掉回 30 都要红。

    只改种子不改迁移，已经在跑的库还是 30 天；只改迁移不改种子，新装的库还是 30 天 —— 两边都不报错。
    """
    import json
    import re

    from backend.app.task.tasks.maintenance.tasks import LOG_RETENTION_DAYS
    from backend.core.path_conf import BASE_PATH

    assert LOG_RETENTION_DAYS >= 180, '网络安全法第二十一条：网络日志留存不少于六个月'
    migration = _load_retention_migration()
    assert json.loads(migration._NEW_KWARGS) == {'days': LOG_RETENTION_DAYS}
    for dialect in ('mysql', 'postgresql', 'sqlserver'):
        seed = (BASE_PATH / 'sql' / dialect / 'init_snowflake_test_data.sql').read_text(encoding='utf-8')
        (line,) = [ln for ln in seed.splitlines() if "'maintenance.prune_logs'" in ln]
        assert f'{migration._SCHEDULER_ID},' in line, f'{dialect} 种子里那条调度的 ID 和迁移对不上'
        days = re.search(r'\{"days": (\d+)\}', line)
        assert days is not None and int(days.group(1)) == LOG_RETENTION_DAYS, f'{dialect} 种子：{line}'
        assert migration._NEW_REMARK in line, f'{dialect} 种子的备注和迁移写的不一样'


def test_retention_migration_only_bumps_the_seed_row_still_at_30(factory):
    """已经装了的库：种子那一行还是 30 才改成 180；管理员调过的不动。整个过程在一个回滚掉的事务里，不改 fba_test。"""
    import json

    from sqlalchemy import update

    from backend.app.task.model import TaskScheduler

    migration = _load_retention_migration()
    t = TaskScheduler.__table__
    engine = factory.kw['bind']

    with engine.connect() as conn:
        trans = conn.begin()
        try:
            assert conn.execute(select(t.c.id).where(t.c.id == migration._SCHEDULER_ID)).first(), (
                'fba_test 里没有种子那条「清理历史日志」调度'
            )

            def set_row(kwargs: str | None, remark: str) -> None:
                conn.execute(update(t).where(t.c.id == migration._SCHEDULER_ID).values(kwargs=kwargs, remark=remark))

            def get_row() -> tuple[str | None, str | None]:
                row = conn.execute(select(t.c.kwargs, t.c.remark).where(t.c.id == migration._SCHEDULER_ID)).one()
                return row.kwargs, row.remark

            # 种子原值；界面上保存过一次、空格没了也算
            for raw in ('{"days": 30}', '{"days":30}'):
                set_row(raw, migration._OLD_REMARK)
                assert migration.bump_seed_retention(conn) is True, raw
                kwargs, remark = get_row()
                assert json.loads(kwargs) == {'days': 180}
                assert remark == migration._NEW_REMARK

            # 管理员改过备注：天数照改，备注不动
            set_row('{"days": 30}', '我们自己写的备注')
            assert migration.bump_seed_retention(conn) is True
            assert get_row() == ('{"days": 180}', '我们自己写的备注')

            # 管理员调过参数（含调得比 180 短的）、清空了、写坏了：一律不动
            for raw in ('{"days": 90}', '{"days": 7}', '{"days": 30, "batch": 500}', None, '', '{days: 30}'):
                set_row(raw, migration._OLD_REMARK)
                assert migration.bump_seed_retention(conn) is False, raw
                assert get_row() == (raw, migration._OLD_REMARK), raw
        finally:
            trans.rollback()


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


# ── 能力开放插件的调用日志（open_api_log）：同一个保留期 ─────────────────────────


def test_prunes_open_api_logs_with_the_same_retention(factory):
    """调用日志和操作日志同口径（含请求 / 响应体），保留期也要一样 —— 漏接的话它会永久增长。

    按业务时间（`request_time`）删，造数据时 `created_time` 故意错开（同 `test_uses_business_time_not_created_time`）。
    """
    from backend.plugin.open.model import OpenApiLog

    def seed(days_ago: float) -> None:
        with factory() as s:
            s.execute(
                OpenApiLog.__table__.insert().values(
                    id=next(_next_id),
                    trace_id=MARK,
                    access_key=MARK,
                    method='GET',
                    title='t',
                    path='/api/open/v1/t',
                    ip='127.0.0.1',
                    status=1,
                    code='200',
                    error_code='ok',
                    cost_time=1.0,
                    request_time=timezone.now() - timedelta(days=days_ago),
                    created_time=timezone.now(),  # ← 故意错开
                )
            )
            s.commit()

    def remaining() -> int:
        with factory() as s:
            stmt = select(func.count()).select_from(OpenApiLog).where(OpenApiLog.access_key == MARK)
            return s.execute(stmt).scalar_one()

    try:
        seed(40)
        seed(40)
        seed(1)
        msg = run_prune(days=30)
        assert '开放接口调用日志 2 条' in msg, msg
        assert remaining() == 1
    finally:
        with factory() as s:
            s.execute(delete(OpenApiLog).where(OpenApiLog.access_key == MARK))
            s.commit()


def test_prunes_webhook_records_with_their_own_retention(factory):
    """Webhook 的事件 / 投递 / 尝试（#167）按自己的保留期（默认 30 天）删，三张表一起，先子后父。

    漏接的话：事件表是**每一次**用户 / 部门 / 审批变更都写一行（没人订阅也写），涨得比日志还快
    """
    from backend.plugin.open.model import OpenEvent, OpenWebhookAttempt, OpenWebhookDelivery

    def seed(days_ago: float) -> int:
        when = timezone.now() - timedelta(days=days_ago)
        event_id, delivery_id = next(_next_id), next(_next_id)
        with factory() as s:
            s.execute(
                OpenEvent.__table__.insert().values(
                    id=event_id, type='dept.updated', aggregate_id=-1, payload='{}', created_time=when
                )
            )
            s.execute(
                OpenWebhookDelivery.__table__.insert().values(
                    id=delivery_id,
                    webhook_id=-1,
                    event_id=event_id,
                    event_type='dept.updated',
                    status='success',
                    attempts=1,
                    created_time=when,
                )
            )
            s.execute(
                OpenWebhookAttempt.__table__.insert().values(
                    id=next(_next_id),
                    delivery_id=delivery_id,
                    attempt=1,
                    url='https://x',
                    duration_ms=1,
                    created_time=when,
                )
            )
            s.commit()
        return event_id

    def remaining() -> tuple[int, int, int]:
        with factory() as s:
            return (
                s.execute(select(func.count()).select_from(OpenEvent).where(OpenEvent.aggregate_id == -1)).scalar_one(),
                s.execute(
                    select(func.count()).select_from(OpenWebhookDelivery).where(OpenWebhookDelivery.webhook_id == -1)
                ).scalar_one(),
                s.execute(
                    select(func.count()).select_from(OpenWebhookAttempt).where(OpenWebhookAttempt.url == 'https://x')
                ).scalar_one(),
            )

    try:
        seed(40)
        seed(1)
        assert remaining() == (2, 2, 2), '前置：两组都在'
        msg = run_prune(days=30)
        assert 'Webhook 事件 / 投递 / 尝试（保留 30 天）3 条' in msg, msg
        assert remaining() == (1, 1, 1)
    finally:
        with factory() as s:
            s.execute(delete(OpenWebhookAttempt).where(OpenWebhookAttempt.url == 'https://x'))
            s.execute(delete(OpenWebhookDelivery).where(OpenWebhookDelivery.webhook_id == -1))
            s.execute(delete(OpenEvent).where(OpenEvent.aggregate_id == -1))
            s.commit()


# ── 数据变更记录（#260）：自己的保留期 + 防篡改链 ───────────────────────────────


def _fresh_anchor(factory) -> None:
    """校验只看这条测试写的：锚点挪到现在的链头（共用的测试库里别的测试删过自己的记录，链上有缺口）"""
    from backend.app.admin.model import DataChange
    from backend.common.data_change import chain

    _, head_table = chain._tables()
    with factory() as s:
        s.execute(delete(DataChange).where(DataChange.trace_id == MARK))
        head = s.execute(select(head_table)).mappings().first()
        if head is not None:
            s.execute(head_table.update().values(anchor_seq=head['head_seq'], anchor_hash=head['head_hash']))
        s.commit()


def _seed_chained(factory, monkeypatch, days_ago: float) -> int:
    """写一条 N 天前的、在链上的记录。记录的时间是拿到链头的锁之后才取的（chain.link），只能把那一刻的时钟拨回去"""
    from backend.app.admin.model import DataChange
    from backend.common.data_change import chain

    row = {
        'id': next(_next_id),
        'trace_id': MARK,
        'entity_type': 'user',
        'entity_id': -1,
        'entity_label': None,
        'action': 'update',
        'changes': [],
        'fields': '',
        'actor_id': None,
        'actor_name': None,
        'source': 'system',
        'source_ref': None,
        'ip': None,
    }
    real_now = timezone.now
    with factory() as s:
        monkeypatch.setattr(timezone, 'now', lambda: real_now() - timedelta(days=days_ago))
        try:
            chain.link(s, [row])
        finally:
            monkeypatch.setattr(timezone, 'now', real_now)
        s.execute(DataChange.__table__.insert(), [row])
        s.commit()
    return row['chain_seq']


def _left(factory) -> set[int]:
    from backend.app.admin.model import DataChange

    with factory() as s:
        return set(s.execute(select(DataChange.chain_seq).where(DataChange.trace_id == MARK)).scalars())


def _verify(factory):
    from backend.common.data_change import chain

    with factory() as s:
        return chain.verify(s)


@pytest.fixture
def changes_db(factory):
    from backend.app.admin.model import DataChange

    _fresh_anchor(factory)
    yield factory
    with factory() as s:
        s.execute(delete(DataChange).where(DataChange.trace_id == MARK))
        s.commit()


def test_prunes_data_changes_with_their_own_retention(changes_db, monkeypatch):
    """数据变更记录（#260）按自己的保留期删（参数配置「日志」组，默认 180 天），**不跟操作日志的 30 天**：
    操作日志删掉之后，「谁把这个字段改了」还要查得到。网络安全法要求网络日志留存不少于六个月"""
    old = _seed_chained(changes_db, monkeypatch, 200)  # 超过 180 天 → 删
    kept = _seed_chained(changes_db, monkeypatch, 60)  # 超过操作日志的 30 天、没到 180 → 留
    msg = run_prune(days=30)
    assert _left(changes_db) == {kept}, msg
    # ⚠️ 不断言删了几条：`_fresh_anchor` 把锚点人为挪到了链头，锚点之前别的测试留下的行这次也会被删
    # （真实环境里锚点只会推到「第一条还要留的」前一条，锚点之前的行一定已经过了保留期）。单跑是 1 条，全套跑是几百条
    assert '数据变更记录（保留 180 天）' in msg
    assert old < kept


def test_pruning_chained_data_changes_keeps_the_chain_verifiable(changes_db, monkeypatch):
    """防篡改链：清理先把锚点推到要删的最后一个序号、再按序号删。反过来（按时间删、锚点不动）的话，
    校验会把一次正常的清理报成「中间被删了几行」"""
    old = _seed_chained(changes_db, monkeypatch, 200)
    _seed_chained(changes_db, monkeypatch, 60)
    assert _verify(changes_db).ok, '前置：清理之前链是好的'
    msg = run_prune(days=30)
    report = _verify(changes_db)
    assert report.anchor_seq == old
    assert report.ok, report.problems
    # 链头写进任务日志：库外的旁证
    assert '防篡改链：链头 #' in msg


def test_pruning_never_takes_a_record_still_in_retention(changes_db, monkeypatch):
    """🔴 评审抓到的：多实例时钟有偏差时序号和时间不严格同序。按「早于 cutoff 的最大序号」推锚点的话，
    序号小、但还在保留期里的那一行会被一起删掉。现在推到「第一条还要留的」前一条：宁可多留，不少留"""
    a = _seed_chained(changes_db, monkeypatch, 200)
    b = _seed_chained(changes_db, monkeypatch, 60)  # 还在保留期里
    c = _seed_chained(changes_db, monkeypatch, 200)  # 序号比 b 大、时间却更早（时钟偏了的那台实例写的）
    run_prune(days=30)
    assert _left(changes_db) == {b, c}
    assert _verify(changes_db).anchor_seq == a


def test_pruning_without_a_head_row_deletes_no_chained_record(changes_db, monkeypatch):
    """🔴 评审抓到的：链头那一行不在时推不了锚点。原来照删不误，链头重建之后锚点是 0，
    这段被删的就成了永远报着的「缺口」——正常的清理被当成有人删记录"""
    from backend.common.data_change import chain

    old = _seed_chained(changes_db, monkeypatch, 200)
    _, head_table = chain._tables()
    with changes_db() as s:
        s.execute(head_table.delete())
        s.commit()
    run_prune(days=30)
    assert old in _left(changes_db)


def test_pruning_leaves_records_written_around_the_app(changes_db):
    """🔴 评审抓到的：没有序号的行就是绕过应用写进来的（迁移已经把旧记录补签进链）。按时间删它等于替伪造的人销毁证据"""
    from backend.app.admin.model import DataChange

    with changes_db() as s:
        s.execute(
            DataChange.__table__.insert().values(
                id=next(_next_id),
                trace_id=MARK,
                entity_type='user',
                entity_id=-1,
                action='update',
                changes=[],
                fields='',
                source='system',
                created_time=timezone.now() - timedelta(days=400),
            )
        )
        s.commit()
    msg = run_prune(days=30)
    assert _left(changes_db) == {None}, msg
    assert '没有序号的' in msg
