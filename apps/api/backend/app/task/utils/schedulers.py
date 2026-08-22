"""DatabaseScheduler —— 让 celery beat 从 `task_scheduler` 表读调度。

没有它，调度就只能写死在 `tasks/beat.py` 里，改一次发一次版。
有了它，「定时任务」才是界面上能增删改停的东西。

设计上只做三件事，刻意不抄 django-celery-beat 的全套：

1. `ModelEntry` 把一行 `task_scheduler` 翻译成 celery 认识的 `ScheduleEntry`
2. `DatabaseScheduler.all_as_schedule()` 全量读一次
3. 靠 Redis 上的一个时间戳判断「有人改了调度」，变了才重读

🔴 **重载靠时间戳而不是每拍查库**：beat 的 tick 可能一秒一次，每次都
`SELECT *` 是白打数据库。写入侧由 `model/scheduler.py` 的 ORM 事件负责
更新这个时间戳（`after_insert/update/delete`）。
"""

from __future__ import annotations

import json

from datetime import datetime, timedelta
from typing import Any

from celery import current_app
from celery.beat import ScheduleEntry, Scheduler
from celery.schedules import crontab, schedule
from celery.utils.log import get_logger

from backend.app.task.model.scheduler import TaskScheduler
from backend.app.task.sync_db import sync_session
from backend.core.conf import settings
from backend.utils.timezone import timezone

logger = get_logger(__name__)

#: 间隔单位 → timedelta 关键字
PERIODS = {
    'seconds': 'seconds',
    'minutes': 'minutes',
    'hours': 'hours',
    'days': 'days',
    'microseconds': 'microseconds',
}


def _loads(raw: str | None, fallback: Any) -> Any:
    """args/kwargs 存的是 JSON 串。坏数据不能拖垮整个 beat —— 单条退化成默认值。"""
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        logger.warning('任务调度的参数不是合法 JSON，已按空值处理：%r', raw)
        return fallback


def to_schedule(row: TaskScheduler) -> schedule | crontab:
    """把一行调度翻译成 celery 的 schedule 对象。

    `type` 0 = 间隔（每 N 秒/分/时/天），1 = 定时（crontab 表达式）。
    """
    if row.type == 0:
        period = PERIODS.get(row.interval_period or 'seconds', 'seconds')
        return schedule(timedelta(**{period: row.interval_every or 0}))

    # crontab 是 5 段：分 时 日 月 周。少段/多段都当配置错误，
    # 退化成「每分钟」会把一条配错的调度变成每分钟打一次接口，宁可跳过。
    parts = (row.crontab or '').split()
    if len(parts) != 5:
        raise ValueError(f'crontab 表达式必须是 5 段，收到 {row.crontab!r}')
    minute, hour, day_of_month, month_of_year, day_of_week = parts
    return crontab(
        minute=minute,
        hour=hour,
        day_of_month=day_of_month,
        month_of_year=month_of_year,
        day_of_week=day_of_week,
    )


class ModelEntry(ScheduleEntry):
    """一行 `task_scheduler` 对应的调度项"""

    def __init__(self, model: TaskScheduler, app=None) -> None:  # ruff:ignore[missing-type-function-argument]
        self.app = app or current_app._get_current_object()
        self.model = model
        self.name = model.name
        self.task = model.task
        self.args = _loads(model.args, [])
        self.kwargs = _loads(model.kwargs, {})
        self.options = {
            k: v
            for k, v in {
                'queue': model.queue,
                'exchange': model.exchange,
                'routing_key': model.routing_key,
                'expires': model.expire_seconds,
            }.items()
            if v is not None
        }
        self.schedule = to_schedule(model)
        self.total_run_count = model.total_run_count or 0
        # celery 拿 last_run_at 算下次触发。从没跑过的用 start_time，
        # 再没有就用「现在」—— 用 epoch 的话一条新建的日调度会立刻补跑一次
        self.last_run_at = model.last_run_time or model.start_time or timezone.now()

    def is_due(self) -> tuple[bool, float]:
        """到点了吗。四种情况直接判不到期，并给一个较长的下次检查间隔。"""
        now = timezone.now()

        if not self.model.enabled:
            return False, 60.0
        if self.model.start_time and now < self.model.start_time:
            return False, 60.0
        if self.model.expire_time and now >= self.model.expire_time:
            return False, 60.0
        # one_off 跑过一次就不再触发（不是删除 —— 记录要留着给执行记录页看）
        if self.model.one_off and self.total_run_count >= 1:
            return False, 60.0

        return self.schedule.is_due(self.last_run_at)

    def __next__(self) -> ModelEntry:
        """触发之后 celery 调它拿下一轮的 entry"""
        self.model.last_run_time = timezone.now()
        self.model.total_run_count = (self.model.total_run_count or 0) + 1
        # 🔴 回写是 beat 自己的动作，不是「用户改了调度」——
        # 不置这个标记，每触发一次就会打一次 last_update，beat 每跑一个任务
        # 就全量重载一次调度表
        self.model.no_changes = True
        self._persist()
        return self.__class__(self.model, app=self.app)

    def _persist(self) -> None:
        """🔴 触发计数必须**立刻**落库，不能只等 `sync()`。

        `is_due()` 里 one_off 的判断读的是 `total_run_count`，而
        `DatabaseScheduler.schedule` 一检测到变更就**重载**，把这个计数
        清回库里的值。于是：一次性任务触发之后、`sync()` 回写之前，
        只要有人改了**任何一条**调度（增删改都会打变更标记 → 触发重载），
        它就会再跑一次 —— 一次性任务跑两遍。

        发现方式是集成测试**间歇性**失败（同一批用例三跑两绿一红），
        红的那次报「one_off 触发了第二次」。单跑永远是绿的，因为没有
        别的用例在同一个会话里改调度。**这条如果只手工验，几乎不可能撞到。**

        代价是每次真触发多一条 UPDATE —— 只在到点时发生，不是每个 tick。
        用 core update 而不是 ORM：core update 不触发 `after_update` 事件，
        否则这次写入自己又会打一次变更标记，变成「触发一次就重载一次」。
        """
        try:
            with sync_session() as db:
                db.query(TaskScheduler).filter(TaskScheduler.id == self.model.id).update(
                    {'last_run_time': self.model.last_run_time, 'total_run_count': self.model.total_run_count},
                    synchronize_session=False,
                )
        except Exception as e:  # noqa: BLE001
            # 写失败不能让调度停摆 —— 最坏是这一条的计数偏小、one_off 可能多跑一次
            logger.warning('回写任务调度触发计数失败 %s：%s', self.model.name, e)

    next = __next__  # celery 内部两种写法都用


class DatabaseScheduler(Scheduler):
    """从数据库读调度的 beat 调度器"""

    Entry = ModelEntry

    #: 没有变更信号时，最多多久强制重读一次（秒）
    max_interval = 60

    def __init__(self, *args, **kwargs) -> None:  # ruff:ignore[missing-type-function-argument]
        self._schedule: dict[str, ModelEntry] = {}
        self._last_seen_update: str | None = None
        self._dirty: set[str] = set()
        super().__init__(*args, **kwargs)

    # -- 读 ----------------------------------------------------------------

    def all_as_schedule(self) -> dict[str, ModelEntry]:
        """全量读一次调度表。单条坏数据只跳过它自己，不能让整个 beat 起不来。"""
        entries: dict[str, ModelEntry] = {}
        with sync_session() as db:
            rows = db.query(TaskScheduler).filter(TaskScheduler.deleted == 0).all()
            for row in rows:
                try:
                    entries[row.name] = self.Entry(row, app=self.app)
                except Exception as e:  # noqa: BLE001
                    logger.warning('跳过配置有误的任务调度 %s：%s', row.name, e)
        logger.info('已从数据库载入 %d 条任务调度', len(entries))
        return entries

    def _remote_last_update(self) -> str | None:
        """读「调度变过没有」的时间戳。Redis 不可用时返回 None = 不触发重载。"""
        import redis

        try:
            client = redis.Redis(
                host=settings.REDIS_HOST,
                port=settings.REDIS_PORT,
                password=settings.REDIS_PASSWORD or None,
                db=settings.REDIS_DATABASE,
                socket_timeout=2,
            )
            value = client.get(f'{settings.CELERY_REDIS_PREFIX}:last_update')
            return value.decode() if value else None
        except Exception as e:  # noqa: BLE001
            # Redis 挂了不该让 beat 停摆 —— 只是失去「改完立刻生效」的能力，
            # max_interval 到点仍会重读
            logger.warning('读取调度变更标记失败，本轮不重载：%s', e)
            return None

    def setup_schedule(self) -> None:
        self._schedule = self.all_as_schedule()
        self._last_seen_update = self._remote_last_update()

    @property
    def schedule(self) -> dict[str, ModelEntry]:
        latest = self._remote_last_update()
        if latest is not None and latest != self._last_seen_update:
            logger.info('检测到任务调度变更，重新载入')
            self._schedule = self.all_as_schedule()
            self._last_seen_update = latest
        return self._schedule

    @schedule.setter
    def schedule(self, value: dict[str, ModelEntry]) -> None:
        # celery 的 Scheduler.__init__ 会往 self.schedule 赋值，得接住
        self._schedule = value or {}

    # -- 写 ----------------------------------------------------------------

    def sync(self) -> None:
        """把触发次数和最近触发时间写回库。

        beat 周期性调它（也在退出时调一次）。写失败只记日志 ——
        统计数字丢一点，远好过让 beat 崩掉不再调度。
        """
        if not self._schedule:
            return
        try:
            with sync_session() as db:
                for entry in self._schedule.values():
                    m = entry.model
                    if m.last_run_time is None:
                        continue
                    db.query(TaskScheduler).filter(TaskScheduler.id == m.id).update(
                        {'last_run_time': m.last_run_time, 'total_run_count': m.total_run_count},
                        synchronize_session=False,
                    )
        except Exception as e:  # noqa: BLE001
            logger.warning('回写任务调度统计失败：%s', e)


__all__ = ['DatabaseScheduler', 'ModelEntry', 'to_schedule']
