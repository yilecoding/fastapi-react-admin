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

import time

from datetime import timedelta
from types import SimpleNamespace

import pytest

from celery.schedules import BaseSchedule
from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import sessionmaker

from backend.app.task.celery import celery_app
from backend.app.task.model.scheduler import TaskScheduler
from backend.app.task.utils import schedulers as sched_mod
from backend.app.task.utils.schedulers import DatabaseScheduler
from backend.tests.utils.db import sync_test_db_url
from backend.utils.timezone import timezone

#: 间隔统一 60 秒 —— 远大于任何建连/查询抖动
EVERY = 60


@pytest.fixture(scope='module')
def test_factory():
    """指向 fba_test 的同步会话工厂。

    `sync_db` 默认按 `DATABASE_SCHEMA` 连开发库 —— 测试必须改到 `_test` 库，
    否则这组用例会往你正在手测的库里插调度（而且 beat 真在跑的话会执行它）。
    """
    url = sync_test_db_url()
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

    def tick_until_idle(self) -> None:
        """一直 tick 到这一刻没有到期的为止（= beat 把此刻该派的都派完）。

        ⚠️ 不能只 tick 一次：一拍只派**堆顶那一条**。beat 读的是整张表，种子和别的用例留下的行
        （比如前面的用例让种子跑过，它们的 last_run_time 现在又到点了）可能和用例自己的行同时到期 ——
        一拍派到的是谁看对象 id，用例时红时绿。
        """
        for _ in range(10_000):
            if self.tick() > 0:
                return
        raise AssertionError('tick 一直返回 0 —— 忙等')


# ── 到点会不会触发 ──────────────────────────────────────────────────────────


def test_overdue_schedule_fires(db):
    """🔴 全套测试里唯一一条真正回答「定时任务到点会不会跑」的。"""
    insert(db, name='timing-已到点', last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()
    assert s.fired_ours() == ['timing-已到点'], '过了间隔却没有触发'


def test_fresh_schedule_does_not_fire_immediately(db):
    """刚建的调度不能立刻补跑。

    last_run_time 为空时 `last_run_at` 回落成「现在」；回落成 epoch 的话
    一条「每天 3:15」的新调度会被判成欠了两万多天，创建瞬间就跑一次。
    """
    insert(db, name='timing-刚建的', last_run='never')
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()
    assert s.fired_ours() == [], f'刚创建就触发了：{s.fired_ours()}'


def test_disabled_schedule_never_fires(db):
    """停用的调度必须真的不跑 —— 界面上那个开关只有在这里生效才算数。"""
    insert(db, name='timing-停用的', enabled=False, last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()
    assert s.fired_ours() == [], f'停用的调度触发了：{s.fired_ours()}'


def test_expired_schedule_does_not_fire(db):
    """过了截止时间就不再触发。"""
    insert(
        db,
        name='timing-已过期',
        last_run='overdue',
        expire_time=timezone.now() - timedelta(minutes=1),
    )
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()
    assert s.fired_ours() == [], f'过期的调度触发了：{s.fired_ours()}'


def test_not_started_yet_does_not_fire(db):
    """还没到开始时间就不触发。"""
    insert(
        db,
        name='timing-未开始',
        last_run='overdue',
        start_time=timezone.now() + timedelta(hours=1),
    )
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()
    assert s.fired_ours() == [], f'未到开始时间就触发了：{s.fired_ours()}'


def test_one_off_fires_only_once(db):
    """一次性调度触发过就不再触发（记录要留着，所以不是删除）。"""
    pk = insert(db, name='timing-只跑一次', one_off=True, last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()
    assert s.fired_ours() == ['timing-只跑一次']

    # 把「上次触发」再拨回两分钟前 —— 时间上又到点了，只剩计数能拦住它
    with db() as sess:
        sess.execute(
            TaskScheduler.__table__
            .update()
            .where(TaskScheduler.id == pk)
            .values(last_run_time=timezone.now() - timedelta(seconds=EVERY * 2))
        )
        sess.commit()
    s.tick_until_idle()
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
    s.tick_until_idle()
    assert s.fired_ours() == [], f'软删的调度触发了：{s.fired_ours()}'


# ── 触发之后的回写 ──────────────────────────────────────────────────────────


def test_run_counters_land_in_db(db):
    """🔴 触发次数和最近触发时间要落库 —— 界面上那两列的数据源。

    不落库的话「累计触发次数」永远是 0，用户没有任何办法判断这条调度到底
    有没有在跑（而这恰恰是他打开这一页最想知道的事）。
    """
    pk = insert(db, name='timing-回写', last_run='overdue')
    s = CapturingScheduler(app=celery_app)
    s.tick_until_idle()

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
    s.tick_until_idle()
    assert s.fired_ours() == ['timing-一次性抗重载']

    # 时间上重新到点，但触发计数应该已经落库了
    with db() as sess:
        sess.execute(
            TaskScheduler.__table__
            .update()
            .where(TaskScheduler.id == pk)
            .values(last_run_time=timezone.now() - timedelta(seconds=EVERY * 2))
        )
        sess.commit()

    # 强制重载一次 —— 等价于「用户在这期间改了别的调度」。
    # ⚠️ 一定要走 monkeypatch：直接赋值 + `del` 会把类上真实的方法删掉，
    # 后面的用例全部 AttributeError（写第一版时就这么炸的）
    monkeypatch.setattr(DatabaseScheduler, '_remote_last_update', lambda self: 'changed')
    s._last_seen_update = 'stale'

    # #183 之后跑完的 one_off 重载时直接不载入（`is_retired`）—— 计数没落库的话，
    # 它会带着 0 被重新载入、而且时间上到点了，下面这句就红
    entry = s.schedule.get('timing-一次性抗重载')
    assert entry is None, f'重载后它还在调度里（计数 {entry.total_run_count}）—— 计数没落库的话 one_off 会跑第二次'


def test_schedule_reloads_when_the_change_marker_moves(db, monkeypatch):
    """🔴 「改了调度不用重启 beat」这件事本身必须有测试。

    机制：model 的 after_insert/after_update 事件往 Redis 打一个
    `{CELERY_REDIS_PREFIX}:last_update` 时间戳，`schedule` 这个 property
    每次被读时比一下，变了就重新 `all_as_schedule()`。

    ⚠️ **此前零覆盖。** 实测把那个 `if` 改成 `if False`（永不重载），
    全套 80 条**一条都不红** —— 包括上面那条 `一次性抗重载`，它虽然走了
    重载路径，但断言在「重载没发生」时同样成立（内存里那个 entry 的
    计数也是 1）。它测的是落库，不是重载。

    失败方式完全静默：管理员在界面上改了 cron 或停用了任务，beat 一直按
    老的跑，唯一的补救是重启 beat —— 而界面上显示的是新值，
    所以人只会怀疑自己的 cron 写错了。

    这条按「先断言『没有』再断言『有』」写，中间那步同时钉住了标记的作用：
    **没打标记就不该重载**（否则 last_update 这套是白写的，beat 每一 tick
    都要重读整表）。
    """
    s = CapturingScheduler(app=celery_app)
    assert 'timing-重载新增' not in s.schedule, '预置状态就不干净'

    # beat 已经把调度载进内存了，这时候往库里插一条。
    # ⚠️ `insert()` 走 core insert，不触发 ORM 事件，所以**不会**打变更标记 ——
    # 这正好是中间那步断言要的条件
    insert(db, name='timing-重载新增', id=900000000000000077)
    assert 'timing-重载新增' not in s.schedule, '没打变更标记就重载了 —— 那 last_update 这套白写了'

    # 打上标记（真实路径是 `TaskScheduler.touch_last_update()`，
    # 它自己有测试 `test_touch_last_update_works_without_event_loop`）
    monkeypatch.setattr(DatabaseScheduler, '_remote_last_update', lambda self: 'moved')
    assert 'timing-重载新增' in s.schedule, '标记变了却没重载 —— 界面上改的调度不会生效，只能重启 beat'


def test_table_is_reread_even_if_the_marker_never_moves(db, monkeypatch):
    """标记漏打（Redis 当时不可用、有人绕过 service 改表、迁移里插的调度）也只晚 `reload_every` 生效。

    #183 之前注释里写着「max_interval 到点仍会重读」，实际没有这回事：标记不变就永远不重读，
    改动要等下次重启 beat。变异：去掉按时间重读的那个条件 → 最后一句红。
    """
    monkeypatch.setattr(DatabaseScheduler, '_remote_last_update', lambda self: 'never-moves')
    s = CapturingScheduler(app=celery_app)
    insert(db, name='timing-漏打标记', id=900000000000000078)
    assert 'timing-漏打标记' not in s.schedule, '没到时间就重读了 —— beat 每拍都在查整张表'

    s._loaded_at -= s.reload_every
    assert 'timing-漏打标记' in s.schedule, '标记没动就永远不重读 —— 漏打一次，要等重启 beat'


def test_reload_failure_keeps_beat_running_on_the_old_schedule(db, monkeypatch):
    """🔴 重读时库连不上，beat 不能退出 —— 按内存里的调度接着跑，隔一会儿再试。

    异常要是从 `schedule` 属性抛出去，会经 `tick()` 一路到 celery beat 的 `start_scheduler`，
    记一条 critical 就退出进程。有了定时重读，库抖动超过 `reload_every` 就一定撞上。
    变异：去掉 try → 第一句红；去掉「隔一会儿再试」→ 第二句红（这一拍里每读一次都去连库）。
    """
    insert(db, name='timing-库挂之前就在', id=900000000000000079)
    s = CapturingScheduler(app=celery_app)
    assert 'timing-库挂之前就在' in s.schedule

    calls = []

    def down(self):
        calls.append(1)
        raise ConnectionError('数据库连不上')

    real = DatabaseScheduler.all_as_schedule
    monkeypatch.setattr(DatabaseScheduler, 'all_as_schedule', down)
    s._loaded_at -= s.reload_every
    assert 'timing-库挂之前就在' in s.schedule, '重读失败之后内存里的调度丢了'
    # 同一拍里还会再读好几次（schedules_equal 的参数、reserve、populate_heap）
    s.schedule
    assert len(calls) == 1, f'失败之后没有隔开，又连了 {len(calls) - 1} 次库'

    # 库恢复了。⚠️ 不能 monkeypatch.undo()：那会把 `db` 夹具换掉的 sync_session 一起还原，连回开发库
    insert(db, name='timing-库恢复之后才看到', id=900000000000000080)
    monkeypatch.setattr(DatabaseScheduler, 'all_as_schedule', real)
    s._reload_not_before = 0.0
    assert 'timing-库恢复之后才看到' in s.schedule, '库恢复之后没再重读'


# ── #183：一条永远不到期的调度不能把 beat 堵死 ──────────────────────────────


@pytest.fixture
def clock(monkeypatch):
    """假时钟 + 可控的变更标记。

    上面的用例都只 tick 一次，看不出「堆顶堵死」—— 它要连着跑几个周期才显形，
    而真等几分钟的测试没人会跑。beat 取时间的地方有三处，一起换：我们的 `timezone.now()`
    （is_due 的四道闸、回写 last_run_time）、celery 的 `BaseSchedule.now()`（算到期、算堆里的时间），
    和 `schedulers` 模块里的 `time.monotonic()`（`reload_every` 的定时重读）。

    🔴 第三处漏过一次：只换前两处时，模拟 12 小时实际只过了一秒，定时重读一次都没发生，
    「重读把没跑过的调度一直往后推」（`test_a_never_run_interval_longer_than_reload_every_still_fires`）
    就这么混过了第一轮审查。现在这组每一条都带着生产上每 5 分钟一次的重读在跑。

    起点定在本地 02:00：PostgreSQL 返回 UTC 的 timestamptz，北京时间 0～8 点和 UTC 不是同一天，
    时区那条（`test_crontab_reloaded_from_db_keeps_the_local_wall_clock`）只在这个时段显形。
    """
    state = SimpleNamespace(now=timezone.now().replace(hour=2, minute=0, second=0, microsecond=0), marker='m0')
    origin = state.now
    monkeypatch.setattr(timezone, 'now', lambda: state.now)
    monkeypatch.setattr(BaseSchedule, 'now', lambda self: state.now)
    monkeypatch.setattr(
        sched_mod, 'time', SimpleNamespace(monotonic=lambda: (state.now - origin).total_seconds(), time=time.time)
    )
    monkeypatch.setattr(DatabaseScheduler, '_remote_last_update', lambda self: state.marker)
    monkeypatch.setattr(DatabaseScheduler, 'write_heartbeat', lambda self: None)
    return state


class TimedScheduler(CapturingScheduler):
    """记下每次派发是开跑后第几秒；只排这组用例自己的行。

    ⚠️ 只排 `timing-%`：种子里有 15 秒一次的调度，假时钟一跑几小时就是几千次真实的回写。
    载入走的仍是真的 `all_as_schedule()`（真库、真过滤），只是事后把别人的行摘掉。
    """

    def __init__(self, clock, *a, **kw) -> None:
        self.clock = clock
        self.t0 = clock.now
        self.fired_at: list[tuple[int, str]] = []
        super().__init__(*a, **kw)

    def all_as_schedule(self):
        return {k: v for k, v in super().all_as_schedule().items() if k.startswith('timing-')}

    def apply_entry(self, entry, producer=None) -> None:
        super().apply_entry(entry, producer)
        self.fired_at.append((round((self.clock.now - self.t0).total_seconds()), entry.name))

    def times(self, name: str) -> list[int]:
        return [t for t, n in self.fired_at if n == name]


def drive(s: TimedScheduler, clock, seconds: int, events: dict | None = None) -> None:
    """照 celery `beat.Service.start` 的样子转：tick 返回几秒，时钟就走几秒。

    events：{第几秒: 回调}，时钟走到那一刻先执行（=「这时有人在页面上点了一下」）。
    tick 返回 0 时时钟走 1ms：真机上墙钟自己会走，而 celery 的 `adjust()` 自带 -10ms 漂移，
    时钟不动的话「提前 10ms 醒来 → 还差 0.01 秒 → 返回 0」会原地打转。
    """
    t0 = clock.now
    end = t0 + timedelta(seconds=seconds)
    pending = sorted((events or {}).items())
    for _ in range(200_000):
        while pending and clock.now >= t0 + timedelta(seconds=pending[0][0]):
            pending.pop(0)[1]()
        if clock.now >= end:
            return
        delay = s.tick()
        if delay and delay > 0:
            step = clock.now + timedelta(seconds=delay)
            if pending:
                step = min(step, t0 + timedelta(seconds=pending[0][0]))
            clock.now = min(step, end)
        else:
            clock.now += timedelta(milliseconds=1)
    raise AssertionError('tick 一直返回 0 —— 忙等')


HEART = 'timing-心跳'


def test_a_disabled_schedule_does_not_starve_the_rest(db, clock):
    """🔴 #183 的原样：停用一条调度、重启 beat，之后所有定时任务静默停摆。

    celery 的 `tick()` 只看堆顶，没到期就原样留着。停用的那条按 `now + 60` 进堆，
    比派发完放回去的心跳早一点点 —— 从此堆顶永远是它。tick 照转、调度器心跳照写，
    `/health/status` 只看得到「worker 心跳停了」。修之前这里是 `[0]` 或 `[0, 60]` —— 真机上心跳
    放回去总比停用那条进堆晚一点，是 `[0]`；假时钟下两者同一刻、打平了看对象 id，所以偶尔多一次。
    """
    insert(db, name=HEART, last_run='overdue', id=900000000000000101)
    insert(db, name='timing-停用的', enabled=False, type=1, crontab='30 2 * * *', id=900000000000000102)
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, EVERY * 3 - 30)
    assert s.times(HEART) == [0, 60, 120], f'三个周期里心跳只派了 {s.times(HEART)}'


@pytest.mark.parametrize(
    ('row', 'why'),
    [
        (lambda now: {'expire_time': now - timedelta(days=1), 'last_run': 'overdue'}, '载入时就已过 expire_time'),
        (lambda now: {'one_off': True, 'total_run_count': 1, 'last_run': 'just'}, '载入时 one_off 就已跑过'),
        (lambda now: {'start_time': now + timedelta(hours=1)}, 'start_time 在一小时后'),
        (lambda now: {'one_off': True, 'last_run': 'overdue'}, 'one_off 在 beat 运行中跑完第一次'),
        (lambda now: {'expire_time': now + timedelta(seconds=90), 'last_run': 'overdue'}, 'expire_time 在运行中到点'),
    ],
)
def test_a_schedule_that_never_comes_due_cannot_block_the_heap(db, clock, row, why):
    """🔴 四种「永远不到期」不管是载入时就是、还是跑着跑着变成的，都不能堵住别人。

    载入时就是的三种被 `all_as_schedule` 挡在门外；后两种（start_time 未到、运行中变成的）
    只能靠 tick 把堵在堆顶的挪回堆里。变异：去掉 `_requeue_stale_head` → 后三条红
    （start_time 那条修之前把心跳堵了整整一小时）；去掉载入时的过滤 → 这组仍绿，靠的是 tick 兜底，
    过滤本身由 `test_scheduler.py::test_retired_rows_are_not_loaded` 守。
    """
    insert(db, name=HEART, last_run='overdue', id=900000000000000101)
    insert(db, name='timing-不到期的', id=900000000000000102, **row(clock.now))
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, EVERY * 10)
    assert len(s.times(HEART)) == 10, f'{why}：600 秒里心跳只派了 {s.times(HEART)}'


def _edit(db, clock, name: str = 'timing-每2分钟', **values):
    """= 页面上改了一条调度：写库（DAO 的写会把 updated_time 推到「现在」）+ 提交之后打标记。

    ⚠️ updated_time 要显式给：列上的 `onupdate=timezone.now` 是定义模型时就绑死的那个方法，
    假时钟换不掉它 —— 不给的话写进去的是真实的此刻，在假时钟看来是「未来」，起点会悄悄跑偏。
    """

    def _() -> None:
        with db() as sess:
            sess.execute(
                TaskScheduler.__table__
                .update()
                .where(TaskScheduler.name == name)
                .values(**{'updated_time': clock.now, **values})
            )
            sess.commit()
        clock.marker = repr(values)

    return _


def test_disabling_takes_effect_without_restarting_beat(db, clock):
    """🔴 停用之后（库里已是 enabled=False、标记也打了）beat 不能再派它；重新启用要能接着派。

    修之前两件事都不成立：celery 拿 `ScheduleEntry.__eq__` 比新旧调度，它不比 `enabled`，
    只改启停时判「没变」、不重建堆，堆里的旧 entry 读的是旧 model —— 停了照样派；
    已经堵住的 beat 在页面上重新启用也解不开。现在停用的行载入时就不收，键集合一变 celery
    自己就会重建堆；`schedules_equal` 的重写管的是行还在、只改了 start_time / expire_time 的情况（下一条）。
    变异：去掉载入过滤**和** `schedules_equal` 的重写 → 第一句红（停用后的 240、360 秒照样派了）；只去掉其一仍绿。
    """
    insert(db, name=HEART, last_run='overdue', id=900000000000000101)
    insert(db, name='timing-每2分钟', interval_every=EVERY * 2, last_run='overdue', id=900000000000000102)
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, EVERY * 10, events={150: _edit(db, clock, enabled=False), 390: _edit(db, clock, enabled=True)})

    fired = s.times('timing-每2分钟')
    assert [t for t in fired if 150 < t < 390] == [], f'停用之后还派了：{fired}'
    assert [t for t in fired if t >= 390], f'重新启用之后没再派过：{fired}'
    assert len(s.times(HEART)) == 10


@pytest.mark.parametrize(
    ('change', 'why'),
    [
        (lambda now: {'start_time': now + timedelta(hours=1)}, '把 start_time 推到一小时后'),
        (lambda now: {'expire_time': now + timedelta(seconds=100)}, '把 expire_time 设在 100 秒后'),
    ],
)
def test_editing_start_or_expire_time_takes_effect_without_restarting_beat(db, clock, change, why):
    """🔴 改的字段 celery 不比、这一行也仍在调度里 —— 堆照样得重建。

    `ScheduleEntry.__eq__` 只比 task / args / kwargs / options / schedule。改 start_time /
    expire_time 之后它判「没变」，堆里留着旧 entry（旧 model 上没有这两个时间），照旧每 2 分钟派一次。
    改完从改的那一刻（150 秒）重新计时，下一次本该在 270 秒，已过 250 秒的截止时间，所以两条都该一次不再派。
    变异：去掉 `schedules_equal` 的重写 → 两条都红（150 秒之后还派了 [240, 360, 480]）。
    """
    insert(db, name=HEART, last_run='overdue', id=900000000000000101)
    insert(db, name='timing-每2分钟', interval_every=EVERY * 2, last_run='overdue', id=900000000000000102)
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, EVERY * 10, events={150: lambda: _edit(db, clock, **change(clock.now))()})

    after = [t for t in s.times('timing-每2分钟') if t > 150]
    assert after == [], f'{why}之后还派了：{after}'
    assert len(s.times(HEART)) == 10


def test_crontab_reloaded_from_db_keeps_the_local_wall_clock(db, clock):
    """🔴 每天 02:30 的任务，beat 重载一次不能在 10:30 再跑一次。

    PostgreSQL 按会话时区（默认 UTC）返回 timestamptz，而 crontab 的 `remaining_delta` 拿
    last_run_at 的 `.day` / `.hour` 直接和本地的 now 比。北京时间 0～8 点两边不是同一天，
    下次触发就按 UTC 的钟点算：02:30 本地 = 前一天 18:30 UTC → 「下一个 2 点 30」是 02:30 UTC = 10:30 本地。
    #183 之前只在重启 beat 时重建堆（启动瞬间会多补跑一次）；修完之后每次重载都重建，
    不换算就天天多跑。SQL Server 的 datetimeoffset 存着写入时的偏移、MySQL 读回来是 naive，
    这条只在 PostgreSQL 上会红。变异：去掉 `ModelEntry.__init__` 里的 astimezone → `[0, 30600]`
    （启动即补跑，之后每 5 分钟的重读都按 UTC 钟点算，02:30 那次干脆挪到了 10:30）。
    """
    insert(
        db,
        name='timing-每天0230',
        type=1,
        crontab='30 2 * * *',
        last_run_time=clock.now - timedelta(days=1) + timedelta(minutes=30),
        id=900000000000000103,
    )
    s = TimedScheduler(clock, app=celery_app)
    # 03:00 有人改了别的调度 → 重载；一直跑到 14:00
    drive(s, clock, 12 * 3600, events={3600: lambda: setattr(clock, 'marker', 'someone-edited')})
    assert s.times('timing-每天0230') == [1800], f'一天里触发于（开跑后秒数）：{s.times("timing-每天0230")}'


# ── #183 二轮审查补的几条 ────────────────────────────────────────────────────


def test_a_never_run_interval_longer_than_reload_every_still_fires(db, clock):
    """🔴 每 10 分钟一次、刚建好还没跑过的调度，在每 5 分钟一次的定时重读下也要按时跑。

    从没跑过的 `last_run_at` 原来回落成「现在」，定时重读每次重建 entry，「现在」就跟着往后挪 ——
    到点时间永远在 600 秒之后。现在以库里的 updated_time / created_time 为起点，重读、重启都不变。
    变异：去掉这两个起点（回落成「现在」）→ 红（3 小时 0 次）。
    """
    insert(db, name='timing-每10分钟', interval_every=600, id=900000000000000104)  # 没跑过，created_time = 开跑那一刻
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, 3 * 3600)
    assert s.times('timing-每10分钟')[:5] == [600, 1200, 1800, 2400, 3000], s.times('timing-每10分钟')


def test_an_edit_landing_during_dispatch_is_not_overwritten(db, clock, monkeypatch):
    """🔴 派发那一刻恰好有人停用了它，beat 不能拿旧 model 把它写回去接着派。

    celery 原版 `reserve()` 是 `self.schedule[name] = next(entry)`：右边 `next()` 里 `_persist` 跑一趟库，
    左边那一读正好碰上变更标记就重读 —— 拿旧 model 算出的下一轮 entry 写进刚重读的新字典，停用了的调度
    复活、接着派，直到下一次定时重读。这里让「停用 + 打标记」落在 `_persist` 那一趟里。
    变异：去掉 `reserve` 的重写 → 红（复活后又派了 120、240）。
    """
    insert(db, name=HEART, last_run='overdue', id=900000000000000101)
    insert(db, name='timing-每2分钟', interval_every=EVERY * 2, last_run='overdue', id=900000000000000102)
    real_persist = sched_mod.ModelEntry._persist
    edited: list[int] = []

    def persist_then_user_disables(self) -> None:
        real_persist(self)
        if self.model.name == 'timing-每2分钟' and not edited:
            edited.append(1)
            _edit(db, clock, enabled=False)()

    monkeypatch.setattr(sched_mod.ModelEntry, '_persist', persist_then_user_disables)
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, EVERY * 10)
    assert s.times('timing-每2分钟') == [0], f'停用之后复活了：{s.times("timing-每2分钟")}'
    assert len(s.times(HEART)) == 10


@pytest.mark.parametrize(
    ('row', 'expected'),
    [
        (
            lambda now: {'type': 1, 'crontab': '30 2 * * *', 'last_run_time': now - timedelta(days=1, minutes=-30)},
            [1800],
        ),
        (lambda now: {'one_off': True, 'last_run': 'overdue'}, [0]),
    ],
    ids=['每天0230', 'one_off'],
)
def test_a_failed_write_back_does_not_double_fire_after_a_reload(db, clock, monkeypatch, row, expected):
    """🔴 触发记录没写进库（库抖了一下，`_persist` 只记了 warning），定时重读之后不能再跑一次。

    重读拿的是库里的旧值：每天 02:30 的任务按昨天算、立刻补跑；one_off 计数回到 0 再跑一次。
    原来要恰好有人改调度才会撞上，有了定时重读，5 分钟内必然撞上。
    变异：去掉 `_carry_over_run_stats` → 两条都红（[1800, 2100] / [0, 360]）。
    """
    insert(db, name='timing-回写失败', id=900000000000000105, **row(clock.now))
    real_persist = sched_mod.ModelEntry._persist
    failed: list[int] = []

    def persist_fails_once(self) -> None:
        if self.model.name == 'timing-回写失败' and not failed:
            failed.append(1)  # = 写库失败、只记了一条 warning
            return
        real_persist(self)

    monkeypatch.setattr(sched_mod.ModelEntry, '_persist', persist_fails_once)
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, 2 * 3600)
    assert s.times('timing-回写失败') == expected


def test_an_edit_committed_while_beat_starts_is_not_lost(db, clock, monkeypatch):
    """beat 启动时读完表、还没读标记的那一刻有人提交了改动，要看得到。

    原来先读表、后读标记：两步之间提交的改动被当成「已经看过」，要等定时重读（最多 5 分钟）。
    变异：`setup_schedule` 里换回先读表 → 红。
    """
    real = DatabaseScheduler.all_as_schedule
    edited: list[int] = []

    def load_then_someone_creates(self):
        entries = real(self)
        if not edited:
            edited.append(1)
            insert(db, name='timing-启动时新建的', id=900000000000000106)
            clock.marker = 'created-during-startup'
        return entries

    monkeypatch.setattr(DatabaseScheduler, 'all_as_schedule', load_then_someone_creates)
    s = TimedScheduler(clock, app=celery_app)
    assert 'timing-启动时新建的' in s.schedule, '启动那一刻的改动被当成看过了'


def test_first_run_after_start_time_is_on_time(db, clock):
    """开始时间一到就按时跑，不能因为「没开始时每 60 秒看一次」晚将近一分钟。

    每 30 秒一次、75 秒后开始：第一次该在 105 秒（start_time + 30）。原来没开始时固定报 60 秒，
    60 秒那次看还没开始，下一次看已是 120 秒。变异：改回固定 60 → 红（[120]）。
    """
    insert(
        db,
        name='timing-75秒后开始',
        interval_every=30,
        start_time=clock.now + timedelta(seconds=75),
        id=900000000000000107,
    )
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, 200)
    assert s.times('timing-75秒后开始')[:1] == [105]


def test_orm_writes_tell_beat_only_after_commit(db, monkeypatch):
    """ORM 写法（`session.add` / 改属性再 flush）也要等提交之后才打标记，回滚就不打。

    原来 after_insert / after_update 在 flush 里当场打：beat 可能抢在提交前重载、读到旧行，再把标记记成
    看过了；SQL Server 上那次读还会被这条未提交的 INSERT 挡住（接口测试的探针就因此会卡死）。
    变异：`changed` 改回当场 `touch_last_update()` → 第一句红。
    """
    touched: list[int] = []
    monkeypatch.setattr(TaskScheduler, 'touch_last_update', classmethod(lambda cls, *a, **k: touched.append(1)))

    with db() as sess:
        row = TaskScheduler(name='timing-ORM新建', task='maintenance.prune_logs')
        row.id = 900000000000000108
        sess.add(row)
        sess.flush()
        assert touched == [], 'flush 里（提交前）就打了标记'
        sess.commit()
    assert touched == [1], '提交之后没打标记'

    with db() as sess:
        sess.get(TaskScheduler, 900000000000000108).remark = '改一下'
        sess.flush()
        sess.rollback()
    assert touched == [1], '回滚了还打标记'


@pytest.mark.parametrize(
    ('start_enabled', 'edit', 'expected'),
    [
        (False, {'enabled': True}, []),
        (True, {'crontab': '0 9 * * *'}, [1800]),
    ],
    ids=['停用后重新启用', '把crontab改到今天已过的时刻'],
)
def test_an_edit_does_not_catch_up_runs_missed_before_it(db, clock, start_enabled, edit, expected):
    """🔴 每天 02:30 的调度，10:00 重新启用（或把 crontab 改成 09:00）不能当场跑一次。

    起点原来只看最近一次触发：停用期间错过的那次、改之前已经过去的那次，在点「启用」/ 保存的那一刻当场补跑 ——
    修之前启停根本不生效所以没人见过，修完启用立刻生效就天天见得到。现在起点取最近一次触发和 updated_time 里晚的。
    变异：起点不看 updated_time → 两条都红（都在 28800 秒、也就是 10:00 多跑一次）。
    """
    insert(
        db,
        name='timing-每天0230',
        type=1,
        crontab='30 2 * * *',
        enabled=start_enabled,
        last_run_time=clock.now - timedelta(days=1, minutes=-30),
        id=900000000000000110,
    )
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, 12 * 3600, events={8 * 3600: _edit(db, clock, name='timing-每天0230', **edit)})
    assert s.times('timing-每天0230') == expected


def test_beat_write_backs_leave_updated_time_alone(db, clock):
    """beat 自己的回写（`_persist` / `sync`）不能动 updated_time —— 起点要拿它当「用户最后一次改」。

    原来 Core UPDATE 会经 onupdate 把它推到回写那一刻：每触发一次、每 3 分钟 sync 一次都改一遍，
    界面上「修改时间」那一列其实是最近一次回写的时间。变异：`_persist` 或 `sync` 不带 updated_time → 红。
    """
    pk = insert(db, name='timing-回写不动修改时间', last_run='overdue', id=900000000000000111)
    s = TimedScheduler(clock, app=celery_app)
    s.tick_until_idle()
    s.sync()
    with db() as sess:
        row = sess.execute(select(TaskScheduler).where(TaskScheduler.id == pk)).scalar_one()
    assert row.total_run_count == 1, '前提不成立：没有触发、回写'
    assert row.updated_time is None, f'beat 的回写改了 updated_time：{row.updated_time}'


def test_a_never_run_row_from_before_beat_started_does_not_fire_on_startup(db, clock):
    """🔴 beat 起来之前就在库里、从没跑过的调度，beat 一启动不能当场补跑。

    种子的 created_time 是固定的 2026-08-22：起点要是直接用建好的时刻，全新部署第一次起 beat，从没跑过的种子
    全会当场跑一次 —— 里面有给全员发消息的「每日问候」。所以垫到 beat 启动那一刻（重读不变）。
    变异：去掉这层垫底 → 红（启动即触发）。
    """
    insert(
        db, name='timing-老种子', interval_every=600, created_time=clock.now - timedelta(days=60), id=900000000000000112
    )
    s = TimedScheduler(clock, app=celery_app)
    drive(s, clock, 1200)
    assert s.times('timing-老种子')[:1] == [600], s.times('timing-老种子')


# ── 真实数据的读取 ──────────────────────────────────────────────────────────


def test_reads_crontab_row_with_chinese_name(db):
    """crontab 型调度能从真库读出来，中文名完好（NVARCHAR 生效）。"""
    insert(db, name='timing-中文名称调度', type=1, crontab='15 3 * * *')
    s = CapturingScheduler(app=celery_app)
    assert 'timing-中文名称调度' in s.schedule
