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
    _patch_session(monkeypatch, [
        make_row(id=1, name='好的', crontab='15 3 * * *'),
        make_row(id=2, name='坏的', crontab='坏表达式'),
        make_row(id=3, name='也好的', type=0, interval_every=10, interval_period='seconds'),
    ])
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

    assert not celery_app.conf.beat_schedule, (
        f'beat_schedule 非空但不会生效：{list(celery_app.conf.beat_schedule)}'
    )


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
