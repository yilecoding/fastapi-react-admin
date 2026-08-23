"""「定时」本身的集成测试 —— 唯一覆盖 beat 决策回路的一组。

其余测试全在验「配置和查询」：schema 拦不拦得住坏配置、接口读不读得出来。
**没有一条覆盖「到点了会不会触发」**，而那正是定时任务的全部意义。

这一组打**真实的 fba_test 库**，跑**真实的 celery Scheduler.tick()**，
只换掉两个东西：

- `producer` 置空 + 捕获 `apply_entry` —— 不真往 broker 发消息。
  发出去要起 worker、要等它启动（本仓库约 20 秒），`pnpm test` 会从 3 秒
  变成一分钟以上；而「消息能不能送达 worker」是 celery 的事，不是我们的代码
- `sync_session` 指向 fba_test（默认指向开发库 fba）

🔴 **控制时间，不要等待时间。** 第一版用 1 秒间隔 + `time.sleep(1.2)`，
结果三跑一红 —— SQL Server 建引擎偶尔超过 1 秒，`tick()` 时就已经到点了，
报「刚创建就触发」。间隔和建连耗时同量级的测试天生不稳。
现在一律显式写 `last_run_time`：要它不到期就写「刚刚」，要它到期就写
「两分钟前」，间隔统一 60 秒。**零 sleep，结论不随机器快慢变。**
"""

from datetime import timedelta

import pytest

from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import sessionmaker

from backend.app.task.celery import celery_app, get_result_backend
from backend.app.task.model.scheduler import TaskScheduler
from backend.app.task.utils import schedulers as sched_mod
from backend.app.task.utils.schedulers import DatabaseScheduler
from backend.core.conf import settings
from backend.utils.timezone import timezone

#: 间隔统一 60 秒 —— 远大于任何建连/查询抖动
EVERY = 60


@pytest.fixture(scope='module')
def test_factory():
    """指向 fba_test 的同步会话工厂。

    `sync_db` 默认按 `DATABASE_SCHEMA` 连开发库 —— 测试必须改到 `_test` 库，
    否则这组用例会往你正在手测的库里插调度（而且 beat 真在跑的话会执行它）。
    """
    url = get_result_backend().removeprefix('db+').replace(
        f'/{settings.DATABASE_SCHEMA}?', f'/{settings.DATABASE_SCHEMA}_test?'
    )
    engine = create_engine(url, pool_pre_ping=True, future=True)
    yield sessionmaker(engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def db(test_factory, monkeypatch):
    """把 DatabaseScheduler 用的会话换到 fba_test，并在用例前后清空调度表。"""
    from contextlib import contextmanager

    @contextmanager
    def fake_session():
        with test_factory() as s:
            try:
                yield s
                s.commit()
            except Exception:
                s.rollback()
                raise

    monkeypatch.setattr(sched_mod, 'sync_session', fake_session)

    def purge() -> None:
        """只删自己造的行（`timing-%`）。

        ⚠️ 曾经改成「清整张表」来解决串扰：连跑 8 次全量有 1 次红，报
        `刚创建就触发了：['pytest-2a74439c']` —— 那是接口测试造的调度。
        但清整张表**把种子调度也删了**，于是
        `test_every_schedule_in_db_points_at_a_registered_task` 变成空跑通过
        （库里一条启用的调度都没有，它当然找不到问题）。
        用「把别人的数据删掉」来隔离，代价是破坏别人的前提。

        正确的隔离方式是**收窄断言**而不是扩大清理：beat 读的是整张表，
        那就允许别人的行被载入，只断言 `timing-%` 那些有没有按预期触发
        （见 `fired_ours()`）。
        """
        with test_factory() as s:
            s.execute(delete(TaskScheduler).where(TaskScheduler.name.like('timing-%')))
            s.commit()

    purge()
    yield test_factory
    purge()


def insert(factory, *, last_run: str = 'never', **kw) -> int:
    """插一行调度。

    `last_run` 决定「到没到点」，取代 sleep：
      'never'  —— 从没跑过（last_run_time 为空 → last_run_at 回落成「现在」→ 不到期）
      'just'   —— 刚跑过 → 不到期
      'overdue'—— 两分钟前跑过，而间隔 60 秒 → 到期

    ⚠️ 走 core insert 绕开 ORM 的雪花默认值（那要 `snowflake.init()`，
    这组测试不需要 Redis），所以 id **和 `created_time`** 都要显式给 ——
    `default_factory` 是 ORM 层的，core insert 不触发它。
    """
    now = timezone.now()
    last_run_time = {'never': None, 'just': now, 'overdue': now - timedelta(seconds=EVERY * 2)}[last_run]

    defaults = {
        'id': kw.pop('id', 900000000000000001),
        'name': 'timing-默认',
        'task': 'maintenance.prune_logs',
        'type': 0,
        'interval_every': EVERY,
        'interval_period': 'seconds',
        'crontab': '* * * * *',
        'enabled': True,
        'one_off': False,
        'total_run_count': 0,
        'deleted': 0,
        'created_time': now,
        'last_run_time': last_run_time,
    }
    defaults.update(kw)
    with factory() as s:
        s.execute(TaskScheduler.__table__.insert().values(**defaults))
        s.commit()
    return defaults['id']


class CapturingScheduler(DatabaseScheduler):
    """真的 beat 调度器，只是不往 broker 发。"""

    def __init__(self, *a, **kw) -> None:
        self.fired: list[str] = []
        super().__init__(*a, **kw)

    @property
    def producer(self):
        # tick() 里会取它；返回 None 免得去连 broker
        return None

    def apply_entry(self, entry, producer=None) -> None:
        # celery 真判到点了才会走到这里。reserve() 已经在 tick 里调过 __next__，
        # 计数和 last_run_time 此时已经推进并落库
        self.fired.append(entry.name)

    def fired_ours(self) -> list[str]:
        """只看这组用例自己造的调度。

        beat 读的是**整张表**，库里还有种子调度和别的用例留下的行 ——
        断言 `fired == []` 会被它们打断。收窄断言比清空别人的数据安全。
        """
        return [n for n in self.fired if n.startswith('timing-')]


# ── 到点会不会触发 ──────────────────────────────────────────────────────────


def test_overdue_schedule_fires(db):
    """🔴 全套测试里唯一一条真正回答「定时任务到点会不会跑」的。"""
    insert(db, name='timing-已到点', last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == ['timing-已到点'], '过了间隔却没有触发'


def test_fresh_schedule_does_not_fire_immediately(db):
    """刚建的调度不能立刻补跑。

    last_run_time 为空时 `last_run_at` 回落成「现在」；回落成 epoch 的话
    一条「每天 3:15」的新调度会被判成欠了两万多天，创建瞬间就跑一次。
    """
    insert(db, name='timing-刚建的', last_run='never')
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == [], f'刚创建就触发了：{s.fired_ours()}'


def test_disabled_schedule_never_fires(db):
    """停用的调度必须真的不跑 —— 界面上那个开关只有在这里生效才算数。"""
    insert(db, name='timing-停用的', enabled=False, last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == [], f'停用的调度触发了：{s.fired_ours()}'


def test_expired_schedule_does_not_fire(db):
    """过了截止时间就不再触发。"""
    insert(
        db, name='timing-已过期', last_run='overdue',
        expire_time=timezone.now() - timedelta(minutes=1),
    )
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == [], f'过期的调度触发了：{s.fired_ours()}'


def test_not_started_yet_does_not_fire(db):
    """还没到开始时间就不触发。"""
    insert(
        db, name='timing-未开始', last_run='overdue',
        start_time=timezone.now() + timedelta(hours=1),
    )
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == [], f'未到开始时间就触发了：{s.fired_ours()}'


def test_one_off_fires_only_once(db):
    """一次性调度触发过就不再触发（记录要留着，所以不是删除）。"""
    pk = insert(db, name='timing-只跑一次', one_off=True, last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == ['timing-只跑一次']

    # 把「上次触发」再拨回两分钟前 —— 时间上又到点了，只剩计数能拦住它
    with db() as sess:
        sess.execute(
            TaskScheduler.__table__.update()
            .where(TaskScheduler.id == pk)
            .values(last_run_time=timezone.now() - timedelta(seconds=EVERY * 2))
        )
        sess.commit()
    s.tick()
    assert s.fired_ours() == ['timing-只跑一次'], 'one_off 触发了第二次'


def test_soft_deleted_row_is_not_scheduled(db):
    """软删的调度不能还在跑。

    ⚠️ `deleted` 不是布尔而是「0 或这一行自己的 id」—— 过滤条件写成
    `deleted.is_(False)` 在 SQL Server 上不报错，只是永远匹配不到。
    """
    pk = insert(db, name='timing-已删除', last_run='overdue')
    with db() as sess:
        sess.execute(TaskScheduler.__table__.update().where(TaskScheduler.id == pk).values(deleted=pk))
        sess.commit()

    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == [], f'软删的调度触发了：{s.fired_ours()}'


# ── 触发之后的回写 ──────────────────────────────────────────────────────────


def test_run_counters_land_in_db(db):
    """🔴 触发次数和最近触发时间要落库 —— 界面上那两列的数据源。

    不落库的话「累计触发次数」永远是 0，用户没有任何办法判断这条调度到底
    有没有在跑（而这恰恰是他打开这一页最想知道的事）。
    """
    pk = insert(db, name='timing-回写', last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick()

    with db() as sess:
        row = sess.execute(select(TaskScheduler).where(TaskScheduler.id == pk)).scalar_one()
        assert row.total_run_count == 1
        assert row.last_run_time is not None


def test_one_off_survives_a_reload(db, monkeypatch):
    """🔴 一次性调度在**重载之后**仍然必须判「不到期」。

    这条是被 flaky 逼出来的：`test_one_off_fires_only_once` 三跑两绿一红，
    红的那次报「one_off 触发了第二次」。根因不是测试写得不好，是设计有洞——
    `is_due()` 读的 `total_run_count` 只在内存里，而 `schedule` 属性一检测到
    变更标记就重载，把它清回库里的 0。于是一次性任务触发之后、`sync()` 回写前，
    **任何人改任何一条调度**都会让它再跑一次。

    ⚠️ 断言直接打在 `is_due()` 上，并且**先把 last_run_time 拨回过去**——
    否则重载出来的 entry 在时间上本来就不到点，测试会因为「还没到点」而通过，
    而不是因为「计数拦住了」。写过一版没拨时间的，去掉 `_persist()` 照样绿，
    是变异验证抓到的。
    """
    pk = insert(db, name='timing-一次性抗重载', one_off=True, last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick()
    assert s.fired_ours() == ['timing-一次性抗重载']

    # 时间上重新到点，但触发计数应该已经落库了
    with db() as sess:
        sess.execute(
            TaskScheduler.__table__.update()
            .where(TaskScheduler.id == pk)
            .values(last_run_time=timezone.now() - timedelta(seconds=EVERY * 2))
        )
        sess.commit()

    # 强制重载一次 —— 等价于「用户在这期间改了别的调度」。
    # ⚠️ 一定要走 monkeypatch：直接赋值 + `del` 会把类上真实的方法删掉，
    # 后面的用例全部 AttributeError（写第一版时就这么炸的）
    monkeypatch.setattr(DatabaseScheduler, '_remote_last_update', lambda self: 'changed')
    s._last_seen_update = 'stale'

    entry = s.schedule['timing-一次性抗重载']
    assert entry.total_run_count == 1, '触发计数没落库，重载后被清回 0'
    assert entry.is_due()[0] is False, '重载把触发计数清掉了，one_off 会跑第二次'


# ── 真实数据的读取 ──────────────────────────────────────────────────────────


def test_reads_crontab_row_with_chinese_name(db):
    """crontab 型调度能从真库读出来，中文名完好（NVARCHAR 生效）。"""
    insert(db, name='timing-中文名称调度', type=1, crontab='15 3 * * *')
    s = CapturingScheduler(app=celery_app)
    assert 'timing-中文名称调度' in s.schedule
