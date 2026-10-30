"""DatabaseScheduler 的单元测试。

这些用例**不打数据库**（`all_as_schedule` 那两条把会话换成了假的），
所以跑得快、不依赖 fba_test 的种子数据。

选题不是「把每个函数都测一遍」，而是照这个仓库的规矩：
**只测那些坏起来是静默的**。标 🔴 的四条各自对应一个真实存在过、
或者照上游抄就会有的 bug —— 每条都做了变异验证（把修复打回去，对应用例会红）。
"""

import json

from datetime import timedelta

import pytest

from celery.schedules import crontab, schedule

from backend.app.task.model.scheduler import TaskScheduler
from backend.app.task.utils import schedulers as sched_mod
from backend.app.task.utils.schedulers import DatabaseScheduler, ModelEntry, to_schedule
from backend.utils.timezone import timezone


def make_row(**kw) -> TaskScheduler:
    """造一行调度。不入库 —— ORM 事件只在 flush 时触发，这里构造是纯内存对象。"""
    row = TaskScheduler(name=kw.pop('name', '演示任务'), task=kw.pop('task', 'maintenance.prune_logs'))
    row.id = kw.pop('id', 1)
    for k, v in kw.items():
        setattr(row, k, v)
    return row


# ── to_schedule ────────────────────────────────────────────────────────────


def test_crontab_five_fields():
    s = to_schedule(make_row(type=1, crontab='15 3 * * *'))
    assert isinstance(s, crontab)
    assert s.minute == {15} and s.hour == {3}


def test_interval_maps_to_timedelta():
    s = to_schedule(make_row(type=0, interval_every=30, interval_period='minutes'))
    assert isinstance(s, schedule)
    assert s.run_every == timedelta(minutes=30)


@pytest.mark.parametrize('bad', ['', '* * *', '* * * * * *', 'every minute'])
def test_malformed_crontab_raises(bad):
    """🔴 段数不对必须抛，不能退化成「每分钟」。

    退化的后果是**放大**而不是缩小：一条配错的调度会变成每分钟打一次接口/发一次邮件，
    而界面上它看起来配的是「每天 3:15」。宁可这一条不生效（`all_as_schedule`
    会跳过它并记一条 warning），也不要它偷偷跑 1440 倍。
    """
    with pytest.raises(ValueError, match='5 段'):
        to_schedule(make_row(type=1, crontab=bad))


# ── 参数解析 ────────────────────────────────────────────────────────────────


def test_args_kwargs_parsed_from_json():
    e = ModelEntry(make_row(args=json.dumps([1, 2]), kwargs=json.dumps({'days': 30})))
    assert e.args == [1, 2]
    assert e.kwargs == {'days': 30}


def test_broken_json_degrades_to_empty():
    """坏 JSON 不能拖垮 beat —— 单条退化成空参数，其余调度照常。"""
    e = ModelEntry(make_row(args='{不是 JSON', kwargs=None))
    assert e.args == []
    assert e.kwargs == {}


# ── is_due 的四道闸 ─────────────────────────────────────────────────────────


def test_disabled_never_due():
    assert ModelEntry(make_row(enabled=False, crontab='* * * * *')).is_due()[0] is False


def test_not_started_yet():
    row = make_row(crontab='* * * * *', start_time=timezone.now() + timedelta(hours=1))
    assert ModelEntry(row).is_due()[0] is False


def test_already_expired():
    row = make_row(crontab='* * * * *', expire_time=timezone.now() - timedelta(hours=1))
    assert ModelEntry(row).is_due()[0] is False


def test_one_off_stops_after_first_run():
    row = make_row(crontab='* * * * *', one_off=True, total_run_count=1)
    assert ModelEntry(row).is_due()[0] is False


# ── 两条回归 ────────────────────────────────────────────────────────────────


def test_next_marks_no_changes():
    """🔴 回写统计不能被当成「用户改了调度」。

    `__next__` 会写 last_run_time/total_run_count。不置 `no_changes`，
    model 的 after_update 事件就会打一次 last_update 时间戳，于是
    **beat 每触发一个任务就全量重载一次调度表** —— 表现不是报错，
    是数据库上莫名其妙多出一堆 SELECT，调度越多越明显。
    """
    row = make_row(crontab='* * * * *')
    assert row.no_changes is False
    ModelEntry(row).__next__()
    assert row.no_changes is True
    assert row.total_run_count == 1
    assert row.last_run_time is not None


def test_new_entry_does_not_backfill_from_epoch():
    """🔴 从没跑过的调度，last_run_at 要用「现在」而不是 epoch。

    celery 拿 last_run_at 算下次触发。回落到 1970 的话，一条
    「每天 3:15」的新调度会被判成「已经欠了两万多天」，创建的瞬间就补跑一次。
    """
    before = timezone.now() - timedelta(seconds=5)
    e = ModelEntry(make_row(crontab='15 3 * * *', last_run_time=None, start_time=None))
    assert e.last_run_at >= before


def test_start_time_wins_over_now_for_last_run_at():
    start = timezone.now() - timedelta(days=2)
    e = ModelEntry(make_row(crontab='15 3 * * *', start_time=start))
    assert e.last_run_at == start


def test_last_run_at_is_converted_to_the_app_timezone():
    """🔴 库里读出来是 UTC（PostgreSQL 的会话时区）也要换算成应用时区再交给 celery。

    crontab 拿 last_run_at 的 `.day` / `.hour` 和本地 now 比，不换算的话北京时间 0～8 点
    按 UTC 的钟点算下次触发（每天 02:30 的任务会在 10:30 再跑一次）。行为层面的那条在
    `test_scheduler_timing.py::test_crontab_reloaded_from_db_keeps_the_local_wall_clock`，只有 PostgreSQL 红得出来；
    这条在哪个方言的 CI 上都守得住。
    """
    from datetime import UTC

    utc = timezone.now().astimezone(UTC)
    e = ModelEntry(make_row(crontab='30 2 * * *', last_run_time=utc))
    assert e.last_run_at == utc
    assert e.last_run_at.utcoffset() == timezone.now().utcoffset()


# ── all_as_schedule 的隔离性 ────────────────────────────────────────────────


class _FakeQuery:
    def __init__(self, rows) -> None:
        self._rows = rows

    def filter(self, *a, **k):
        return self

    def all(self):
        return self._rows


class _FakeSession:
    def __init__(self, rows) -> None:
        self._rows = rows

    def query(self, *a, **k):
        return _FakeQuery(self._rows)


def _patch_session(monkeypatch, rows):
    from contextlib import contextmanager

    @contextmanager
    def fake():
        yield _FakeSession(rows)

    monkeypatch.setattr(sched_mod, 'sync_session', fake)


def test_one_broken_row_does_not_kill_the_rest(monkeypatch):
    """🔴 一条配错的调度只能拖垮它自己。

    `all_as_schedule` 里不 try 的话，库里任何一条 crontab 写错的记录都会让
    **beat 起不来** —— 所有定时任务一起停摆，而日志里只有一句
    ValueError，看不出是哪一条。
    """
    _patch_session(
        monkeypatch,
        [
            make_row(id=1, name='好的', crontab='15 3 * * *'),
            make_row(id=2, name='坏的', crontab='坏表达式'),
            make_row(id=3, name='也好的', type=0, interval_every=10, interval_period='seconds'),
        ],
    )
    s = DatabaseScheduler.__new__(DatabaseScheduler)
    s.app = None
    entries = DatabaseScheduler.all_as_schedule(s)
    assert set(entries) == {'好的', '也好的'}


def test_soft_deleted_rows_are_filtered(monkeypatch):
    """软删的调度不能还在跑。

    ⚠️ `deleted` 不是布尔，是「0 或这一行自己的 id」，所以过滤条件是
    `deleted == 0`；写成 `deleted.is_(False)` 在 SQL Server 上不会报错，
    只是永远匹配不到 —— 又是一个静默失败。
    """
    _patch_session(monkeypatch, [make_row(id=1, name='活的', crontab='* * * * *')])
    s = DatabaseScheduler.__new__(DatabaseScheduler)
    s.app = None
    assert set(DatabaseScheduler.all_as_schedule(s)) == {'活的'}


def test_retired_rows_are_not_loaded(monkeypatch):
    """🔴 停用 / 过期 / one_off 跑完的不进 beat（#183）。

    进了也不会触发，但它们按 `now + 60` 进堆，一排到堆顶就把所有调度堵死 —— celery 的
    `tick()` 对没到期的堆顶原样留着。还没到 start_time 的要照样载入：到点它得自己开始跑。
    变异：去掉 `all_as_schedule` 里的 `is_retired` → 红。
    """
    now = timezone.now()
    _patch_session(
        monkeypatch,
        [
            make_row(id=1, name='正常', crontab='* * * * *'),
            make_row(id=2, name='停用', crontab='* * * * *', enabled=False),
            make_row(id=3, name='过期', crontab='* * * * *', expire_time=now - timedelta(minutes=1)),
            make_row(id=4, name='一次性跑完', crontab='* * * * *', one_off=True, total_run_count=1),
            make_row(id=5, name='一次性没跑', crontab='* * * * *', one_off=True, total_run_count=0),
            make_row(id=6, name='还没开始', crontab='* * * * *', start_time=now + timedelta(hours=1)),
        ],
    )
    s = DatabaseScheduler.__new__(DatabaseScheduler)
    s.app = None
    assert set(DatabaseScheduler.all_as_schedule(s)) == {'正常', '一次性没跑', '还没开始'}


# ── 变更标记 ────────────────────────────────────────────────────────────────


def test_touch_last_update_works_without_event_loop(monkeypatch):
    """🔴 没有事件循环时也要能打标记。

    上游是 `asyncio.create_task(...)`。SQLAlchemy 的 ORM 事件是**同步**回调，
    而 beat / worker / 同步脚本里通常没有运行中的循环 —— `create_task`
    抛 `RuntimeError: no running event loop`，把一次本来成功的保存变成 500，
    用户看到的是「改调度失败」，跟调度本身毫无关系。
    """
    written = {}

    class _FakeRedis:
        async def set(self, k, v):
            written[k] = v

    import backend.database.redis as redis_mod

    monkeypatch.setattr(redis_mod, 'redis_client', _FakeRedis())
    TaskScheduler.touch_last_update()  # 此处没有运行中的事件循环
    assert len(written) == 1
    assert next(iter(written)).endswith(':last_update')


def test_touch_last_update_never_writes_the_same_marker_twice(monkeypatch):
    """🔴 同一秒里打两次，beat 也得看得出是两次（#183）。

    beat 只比「和上次读到的相不相等」。原来写的是精确到秒的时间：开关连点两下，
    或者新建时提交前的 ORM 事件和提交后的那次各打一下，写出同一个值 —— 第二次 beat 看不见，
    停在第一次的状态。变异：值改回 `timezone.to_str(timezone.now())` → 红。
    """
    values: list[str] = []

    class _FakeRedis:
        async def set(self, k, v):
            values.append(v)

    import backend.database.redis as redis_mod

    monkeypatch.setattr(redis_mod, 'redis_client', _FakeRedis())
    frozen = timezone.now()
    monkeypatch.setattr(timezone, 'now', lambda: frozen)
    TaskScheduler.touch_last_update()
    TaskScheduler.touch_last_update()
    assert values[0] != values[1]


def test_marker_write_failure_is_caught_inside_the_task(monkeypatch):
    """有事件循环时标记是 `create_task` 出去写的，写失败要在协程里接住、记 warning（#183 review）。

    外面那层 try 接不到后台任务的异常：Redis 暂时不可用时只剩一句 asyncio 的
    「Task exception was never retrieved」，那条「打标记失败、定时重读会补上」的 warning 从来打不出来。
    变异：去掉 `_write_marker` 里的 try → `gather` 把异常抛出来，红。
    """
    import asyncio

    import backend.database.redis as redis_mod

    from backend.app.task.model import scheduler as model_mod
    from backend.common.log import log

    class _DownRedis:
        async def set(self, k, v):
            raise ConnectionError('Redis 暂时不可用')

    monkeypatch.setattr(redis_mod, 'redis_client', _DownRedis())
    warnings: list[str] = []
    sink = log.add(lambda message: warnings.append(str(message)), level='WARNING')

    async def main() -> None:
        TaskScheduler.touch_last_update()  # 有运行中的循环 → create_task
        await asyncio.gather(*model_mod._background)

    try:
        asyncio.run(main())
    finally:
        log.remove(sink)
    assert any('打任务调度变更标记失败' in w for w in warnings), warnings


def test_unregistered_task_is_reported_once_not_on_every_reload(monkeypatch):
    """指向未注册任务的调度，同一条只喊一次 ERROR（#183 review）。

    定时重读每 5 分钟读一遍表，不去重就是一天 288 条 ERROR —— 按级别告警的监控被刷屏、最后被静音，
    真正的错误跟着被淹掉。变异：去掉「喊过就不再喊」→ 红（2 条）。
    """
    from types import SimpleNamespace

    _patch_session(monkeypatch, [make_row(id=1, name='改了名的', task='maintenance.old_name', crontab='15 3 * * *')])
    logged: list[tuple] = []
    monkeypatch.setattr(sched_mod.logger, 'error', lambda *a, **k: logged.append(a))
    s = DatabaseScheduler.__new__(DatabaseScheduler)
    s.app = SimpleNamespace(tasks={'maintenance.prune_logs': object()})
    s._unregistered_reported = set()
    DatabaseScheduler.all_as_schedule(s)
    DatabaseScheduler.all_as_schedule(s)
    assert len(logged) == 1


def test_sync_redis_client_is_reused(monkeypatch):
    """beat 每拍要读一两次变更标记，不能每次新建客户端 —— 那是每次一条新的 TCP 连接。

    变异：去掉缓存、每次 `redis.Redis(...)` → 红。
    """
    monkeypatch.setattr(sched_mod, '_redis_client', None)
    assert sched_mod._sync_redis() is sched_mod._sync_redis()


# ── 调度只有一个来源 ────────────────────────────────────────────────────────


def test_beat_schedule_config_is_empty():
    """🔴 调度只能来自 `task_scheduler` 表，`app.conf.beat_schedule` 必须是空的。

    `DatabaseScheduler.setup_schedule()` 只 SELECT 那张表，**从不合并**
    `app.conf.beat_schedule`。曾经两边都配着，`celery.py` 里的注释还写
    「静态项仍然生效」—— 实测是死代码：celery.conf 里躺着一条谁也不会执行的调度，
    而下一个人读到那句注释会以为它是兜底。

    往 `beat_schedule` 里加东西的**唯一**正确做法是：要么改成在
    `setup_schedule()` 里显式合并（那要先想清楚「界面上删掉一条，
    代码里的副本会不会把它复活」），要么走种子 SQL。这条挡住第三条路——
    「加了但不生效」。
    """
    from backend.app.task.celery import celery_app

    assert not celery_app.conf.beat_schedule, f'beat_schedule 非空但不会生效：{list(celery_app.conf.beat_schedule)}'


def test_setup_schedule_reads_only_the_database(monkeypatch):
    """setup_schedule 拿到的条目必须**只**来自库，不掺 celery 的默认条目。

    celery 的 `Scheduler.setup_schedule()` 会 `install_default_entries()`，
    塞一条 `celery.backend_cleanup`。我们重写掉了它 —— 所以那条不会自己出现，
    执行记录的清理必须由 `maintenance.prune_task_results` 自己排（见种子 SQL）。
    这条把「重写」这个事实钉住：哪天有人调回 super()，它会红。
    """
    _patch_session(monkeypatch, [make_row(id=1, name='只有我', crontab='15 3 * * *')])
    s = DatabaseScheduler.__new__(DatabaseScheduler)
    s.app = None
    assert set(DatabaseScheduler.all_as_schedule(s)) == {'只有我'}
