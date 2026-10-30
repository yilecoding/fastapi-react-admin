"""DatabaseScheduler —— 让 celery beat 从 `task_scheduler` 表读调度。

没有它，调度就只能写死在 `tasks/beat.py` 里，改一次发一次版。
有了它，「定时任务」才是界面上能增删改停的东西。

设计上只做三件事，刻意不抄 django-celery-beat 的全套：

1. `ModelEntry` 把一行 `task_scheduler` 翻译成 celery 认识的 `ScheduleEntry`
2. `DatabaseScheduler.all_as_schedule()` 全量读一次
3. 靠 Redis 上的一个时间戳判断「有人改了调度」，变了才重读

🔴 **重载靠变更标记而不是每拍查库**：beat 的 tick 可能一秒一次，每次都
`SELECT *` 是白打数据库。写入侧是 DAO 的增 / 改 / 启停 / 删在**提交之后**
打标记（`TaskScheduler.touch_last_update_after_commit`，DAO 里调）；model 上的 ORM 事件
只管得到 ORM 写法（也改成提交后打），crud 的按列更新 / 删除一个都不触发（#183）。
标记漏打的兜底是 `reload_every` 的定时重读。

🔴 **celery 的 `tick()` 只看堆顶那一条，没到期就原样留着**（#183）。一条永远
不到期的调度（停用 / 过期 / one_off 跑过 / 还没到 start_time）排到堆顶，后面所有
调度就都轮不到了。三道防线：载入时不收（`is_retired`）、重载必重建堆
（`schedules_equal`）、tick 把堵在堆顶的挪回堆里（`_requeue_stale_head`）。
"""

from __future__ import annotations

import heapq
import json
import time

from datetime import datetime, timedelta
from typing import Any

from celery import current_app
from celery.beat import ScheduleEntry, Scheduler, event_t
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


def _aware(value: datetime) -> datetime:
    """换算到应用时区。

    🔴 PostgreSQL 按会话时区（默认 UTC）返回 timestamptz，而 crontab 的 `remaining_delta` 拿 last_run_at 的
    `.day` / `.hour` 直接和本地的 now 比 —— 北京时间 0～8 点两边不是同一天，下次触发按 UTC 的钟点算：
    每天 02:30 的任务 beat 在 02:30 之前启动会立刻补跑；修完「重读必重建堆」之后每次重读都这么算，02:30 那次挪到 10:30。
    naive 值不能直接 astimezone —— 那是按操作系统时区解释（同 `common/model.py: TimeZone`），先补成应用时区。
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.tz_info)
    return value.astimezone(timezone.tz_info)


def is_retired(row: TaskScheduler, now: datetime) -> bool:
    """停用 / 已过 expire_time / one_off 已经跑过：不会自己再变回能触发的状态。

    要变回来只能有人改它，而改了会打变更标记、触发重载 —— 所以载入时直接不收。
    还没到 start_time 的**不算**：到点它自己就该开始跑，照样载入，
    靠 `DatabaseScheduler._requeue_stale_head` 不让它在那之前堵住别人。
    """
    return (
        not row.enabled
        or (row.expire_time is not None and now >= row.expire_time)
        or (row.one_off and (row.total_run_count or 0) >= 1)
    )


class ModelEntry(ScheduleEntry):
    """一行 `task_scheduler` 对应的调度项"""

    def __init__(self, model: TaskScheduler, app: Any = None, *, loaded_since: datetime | None = None) -> None:
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
        self.last_run_at = self._anchor(model, loaded_since)

    @staticmethod
    def _anchor(model: TaskScheduler, loaded_since: datetime | None) -> datetime:
        """celery 拿 `last_run_at` 算下次触发 —— 这里决定从哪一刻算起（#183）。

        | 这一行 | 起点 |
        |---|---|
        | 跑过 | 最近一次触发 |
        | 没跑过、有 start_time | start_time |
        | 没跑过、没 start_time | 建好的时刻，但不早于这个 beat 进程启动的时刻（`loaded_since`） |
        | 用户改过（含停用后重新启用、改 crontab） | 上面那个和 `updated_time` 取晚的 |

        🔴 没跑过的不能回落成「现在」：beat 每 `reload_every` 秒重读、重建 entry，「现在」跟着往后挪，
        间隔比重读周期长的新调度**永远不到期**（实测每 10 分钟一次的 3 小时 0 次）。
        🔴 也不能直接用建好的时刻：种子的 `created_time` 是固定的 2026-08-22，全新部署第一次起 beat，
        从没跑过的种子全会当场补跑一次 —— 里面有给全员发消息的「每日问候」。所以垫到 beat 启动那一刻，
        重读不变；重启会重置（没跑过、间隔又比重启周期长的，和修之前一样要等）。
        🔴 改过要从改的那一刻算：否则重新启用一条每天 02:30 的调度，停用期间错过的那次会在点「启用」时当场补跑；
        把 crontab 改到今天已经过去的时刻也一样。`updated_time` 只有用户的写会动 —— beat 自己的回写
        （`_persist` / `sync`）显式 `SET updated_time = updated_time`，不让 onupdate 把它改成回写时刻。
        代价：间隔型调度改个备注也会从改的那一刻重新计时。
        """
        if model.last_run_time:
            base = _aware(model.last_run_time)
        elif model.start_time:
            base = _aware(model.start_time)
        else:
            base = _aware(model.created_time) if model.created_time else timezone.now()
            if loaded_since and base < loaded_since:
                base = loaded_since
        if model.updated_time and _aware(model.updated_time) > base:
            base = _aware(model.updated_time)
        return base.astimezone(timezone.tz_info)

    def is_due(self) -> tuple[bool, float]:
        """到点了吗。四种情况直接判不到期，并给一个较长的下次检查间隔。

        ⚠️ 判不到期**不会**让 celery 把它挪开：`Scheduler.tick()` 对没到期的堆顶是原样留着的。
        这四种里任何一条排到堆顶都会堵住所有调度，挪开它的是 `DatabaseScheduler._requeue_stale_head`。
        one_off 跑过一次就不再触发（不是删除 —— 记录要留着给执行记录页看）。
        """
        now = timezone.now()

        if is_retired(self.model, now):
            return False, 60.0
        if self.model.start_time and now < self.model.start_time:
            # 正好在 start_time 那一刻再看一次：固定 60 秒的话 `_requeue_stale_head` 按它挪堆，
            # 开始之后的第一次触发最多晚将近一分钟
            return False, min(60.0, (self.model.start_time - now).total_seconds())

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
                    {
                        'last_run_time': self.model.last_run_time,
                        'total_run_count': self.model.total_run_count,
                        # 显式写回原值，onupdate 就不会把它改成「现在」—— 它得留着当「用户最后一次改它」（见 `_anchor`）
                        'updated_time': TaskScheduler.updated_time,
                    },
                    synchronize_session=False,
                )
        except Exception as e:
            # 写失败不能让调度停摆 —— 最坏是这一条的计数偏小、one_off 可能多跑一次
            logger.warning('回写任务调度触发计数失败 %s：%s', self.model.name, e)

    next = __next__  # celery 内部两种写法都用


_redis_client: Any = None


def _sync_redis() -> Any:
    """beat 是同步进程，用同步客户端（应用那个 `redis_client` 是异步的）。

    一个进程只建一个：`schedule` 每拍要读一两次变更标记，每次新建客户端就是每次一条新的 TCP 连接。
    redis-py 的客户端自带连接池，Redis 重启之后会自己重连。
    """
    global _redis_client
    if _redis_client is None:
        import redis

        _redis_client = redis.Redis(
            host=settings.REDIS_HOST,
            port=settings.REDIS_PORT,
            password=settings.REDIS_PASSWORD or None,
            db=settings.REDIS_DATABASE,
            socket_timeout=2,
        )
    return _redis_client


class DatabaseScheduler(Scheduler):
    """从数据库读调度的 beat 调度器"""

    Entry = ModelEntry

    #: 两拍之间最多睡多久（秒）。⚠️ 它**不是**重读间隔 —— 重读看变更标记和下面的 `reload_every`
    max_interval = 60

    #: 没有变更标记时，最多多久无条件重读一次调度表（秒）。标记漏打（Redis 当时不可用、
    #: 有人绕过 service 直接改表、迁移里插的调度）时，最多晚这么久生效，而不是等到下次重启
    reload_every = 300

    #: 重读失败（库暂时连不上）后隔多久再试（秒）
    reload_retry_after = 30

    #: 调度器心跳最多多久写一次（秒）。tick 可能一秒好几次，没必要每拍都写
    heartbeat_every = 15

    #: 这个 beat 进程起来的时刻：从没跑过的调度最早从这里算起（见 `ModelEntry._anchor`）
    _started_at: datetime | None = None

    def __init__(self, *args, **kwargs) -> None:
        self._started_at = timezone.now()
        self._schedule: dict[str, ModelEntry] = {}
        self._last_seen_update: str | None = None
        self._loaded_at = 0.0
        self._reload_not_before = 0.0
        self._heap_invalidated = False
        self._unregistered_reported: set[tuple[str, str]] = set()
        self._dirty: set[str] = set()
        self._last_heartbeat = 0.0
        super().__init__(*args, **kwargs)

    def tick(self, *args, **kwargs) -> float:
        self.write_heartbeat()
        delay = super().tick(*args, **kwargs)
        if delay and self._requeue_stale_head():
            # 堆顶换人了，立刻再 tick 一次看新的堆顶 —— 按原来的 delay 睡下去，
            # 排在它后面、其实已经到点的调度要白等最多 max_interval
            return 0
        return delay

    def _requeue_stale_head(self) -> bool:
        """把堵在堆顶、其实还不到期的那条按它自己报的下次检查时间挪回堆里（#183）。

        🔴 celery 的 `Scheduler.tick()` 每拍**只看堆顶**：到期就弹出、派发、按下次时间放回；
        **没到期直接 return**，既不弹出也不重新排队。它默认堆里的时间就是到期时间，
        没到期说明别人更不到期。但 `ModelEntry.is_due()` 有四种「永远不到期」
        （见 `is_retired` + 还没到 start_time），它们按 `now + 60` 进堆，
        这个时间一过就排到堆顶，从此下不来 —— 后面所有调度一个都派不出去，而 tick 照转、
        调度器心跳照写，`/health/status` 只看得到「worker 心跳停了」。

        实测（假时钟 + 真实 tick，跑 600 秒）：有一条停用的调度时，每 60 秒的心跳只派了第一次；
        start_time 在一小时后的调度，把心跳堵了整整一小时。

        只挪「真实下次时间比它在堆里的位置晚 1 秒以上」的：普通的「还没到点」两者相等，
        celery 自带 10ms 漂移（`adjust`），不留余量会在每个调度到点前空转几拍。
        """
        heap = self._heap
        if not heap:
            return False
        head = heap[0]
        is_due, next_time_to_run = self.is_due(head.entry)
        if is_due:
            return False
        when = self._when(head.entry, next_time_to_run)
        if when - head.time < 1:
            return False
        heapq.heapreplace(heap, event_t(when, head.priority, head.entry))
        return True

    def reserve(self, entry: ModelEntry) -> ModelEntry:
        """🔴 记账时不经 `self.schedule` 属性（#183 review）。

        celery 原版是 `self.schedule[entry.name] = next(entry)`：右边 `next()` 里 `_persist` 要跑一趟库，
        然后左边那一读可能正好碰上变更标记、触发重读 —— 拿旧 model 算出的下一轮 entry 再写进刚重读的
        新字典，把新 entry 盖掉：刚停用、刚删掉的调度被写回去接着派发，直到下一次重读。
        这一步只记账，重读留给下一拍开头（那时会连堆一起重建）。
        """
        new_entry = self._schedule[entry.name] = next(entry)
        return new_entry

    def schedules_equal(self, *args, **kwargs) -> bool:
        """🔴 重载过就一律当「变了」，让 tick 重建堆（#183）。

        celery 拿 `ScheduleEntry.__eq__` 比新旧调度，它只比 task / args / kwargs / options /
        schedule（`editable_fields_equal`），**不比 enabled / start_time / expire_time / one_off**。
        只改了这几项时它判「没变」、不重建堆，堆里留着旧 entry、读的是旧 model ——
        页面上停用了照样派发；派发完 `reserve()` 还拿这个旧 entry 生成下一轮，把重载进来的新 entry 盖掉。
        已经堵住的 beat，在页面上重新启用也解不开，也是这个原因。
        """
        if self._heap_invalidated:
            self._heap_invalidated = False
            return False
        return super().schedules_equal(*args, **kwargs)

    def write_heartbeat(self) -> None:
        """往 Redis 写「调度器还在转」的时间戳，`/health/status` 读它（`core/registrar.py`）。

        🔴 写在调度循环里，不能靠派一个任务：派出去的任务要 worker 执行才落得了地，
        那样 beat 停了和 worker 停了看到的是同一个结果。`max_interval = 60`，
        没有任何调度到期时 tick 也最多 60 秒一拍。写失败只记日志 —— 不能为了心跳让 beat 停摆
        """
        now = time.time()
        if now - self._last_heartbeat < self.heartbeat_every:
            return
        self._last_heartbeat = now
        try:
            _sync_redis().set(settings.SCHEDULER_HEARTBEAT_REDIS_KEY, f'{now:.3f}')
        except Exception as e:
            logger.warning('写调度器心跳失败：%s', e)

    # -- 读 ----------------------------------------------------------------

    def all_as_schedule(self) -> dict[str, ModelEntry]:
        """全量读一次调度表。单条坏数据只跳过它自己，不能让整个 beat 起不来。

        停用 / 过期 / one_off 跑完的不收（`is_retired`）：收进来它们只会在堆里占位，
        排到堆顶就堵住所有调度（#183）。在 Python 里筛而不是写进 WHERE —— 三个方言的
        布尔 / 时间比较不用各验一遍，而且和 `ModelEntry.is_due()` 用的是同一个函数。
        """
        entries: dict[str, ModelEntry] = {}
        registered = set(self.app.tasks) if self.app is not None else set()
        now = timezone.now()
        retired = 0

        with sync_session() as db:
            rows = db.query(TaskScheduler).filter(TaskScheduler.deleted == 0).all()
            for row in rows:
                if is_retired(row, now):
                    retired += 1
                    continue
                try:
                    entries[row.name] = self.Entry(row, app=self.app, loaded_since=self._started_at)
                except Exception as e:
                    logger.warning('跳过配置有误的任务调度 %s：%s', row.name, e)
                    continue

                # 🔴 指向一个不存在的任务是**完全不可见**的失败。
                #
                # 创建时 service 层校验过任务名，但那只挡住「打错字」——
                # 任务名住在**代码**里，改个名或删掉一个任务，库里已有的调度
                # 就指向了空，而没有任何一次写操作会经过校验。
                #
                # 之后发生的事：beat 照常派发 → `total_run_count` 照涨 →
                # worker 收到一个不认识的名字，只在自己的日志里记一条
                # `Received unregistered task`，**不会产生执行记录**。
                # 于是界面上这条调度看着在正常运行（触发次数还在加），
                # 执行记录里却一条都没有 —— 而没人会去比对这两个数。
                #
                # 这里喊出来只是最后一道；主要那道在界面上（列表里把这种行标红）。
                # ⚠️ 同一条只喊一次：定时重读每 5 分钟读一遍，不去重就是一天 288 条 ERROR，
                # 按级别告警的监控会被刷屏、最后被人静音
                key = (row.name, row.task)
                if registered and row.task not in registered and key not in self._unregistered_reported:
                    self._unregistered_reported.add(key)
                    logger.error(
                        '任务调度「%s」指向未注册的任务 %s —— 它会按时触发但什么都不会执行。'
                        '任务名住在代码里，八成是改名或删任务之后忘了改这条调度。',
                        row.name,
                        row.task,
                    )

        logger.info(
            '已从数据库载入 %d 条任务调度（另有 %d 条停用 / 过期 / 一次性已跑完，未载入）', len(entries), retired
        )
        return entries

    def _remote_last_update(self) -> str | None:
        """读「调度变过没有」的标记。Redis 不可用时返回 None = 不按标记重载。"""
        try:
            value = _sync_redis().get(f'{settings.CELERY_REDIS_PREFIX}:last_update')
            return value.decode() if value else None
        except Exception as e:
            # Redis 挂了不该让 beat 停摆 —— 只是失去「改完立刻生效」的能力，
            # 改动要等 `reload_every` 的定时重读才生效
            logger.warning('读取调度变更标记失败，本轮不按标记重载：%s', e)
            return None

    def setup_schedule(self) -> None:
        # 先读标记、再读表：反过来的话，两步之间提交并打了标记的改动会被当成「已经看过」，
        # 要等下一次定时重读才生效（`schedule` 属性里也是这个顺序）
        self._last_seen_update = self._remote_last_update()
        self._schedule = self.all_as_schedule()
        self._loaded_at = time.monotonic()

    @property
    def schedule(self) -> dict[str, ModelEntry]:
        latest = self._remote_last_update()
        changed = latest is not None and latest != self._last_seen_update
        now = time.monotonic()
        if (changed or now - self._loaded_at >= self.reload_every) and now >= self._reload_not_before:
            logger.info('检测到任务调度变更，重新载入' if changed else '定时重读任务调度')
            try:
                fresh = self.all_as_schedule()
            except Exception as e:
                # 🔴 不能往外抛：异常会从 tick() 一路出去，celery beat 记一条 critical 就**退出进程**。
                # 有了定时重读，库抖动超过 reload_every 就一定撞上 —— 没配自动重启的部署，beat 从此不在了。
                # 先按内存里的调度跑，隔一会儿再试（不隔的话这一拍里每读一次 schedule 都去连一次库）
                self._reload_not_before = now + self.reload_retry_after
                logger.warning('重读任务调度失败，先按内存里的调度跑，%d 秒后再试：%s', self.reload_retry_after, e)
                return self._schedule
            self._schedule = self._carry_over_run_stats(fresh, self._schedule)
            self._loaded_at = time.monotonic()
            # 重载了就重建堆，不让 celery 拿 `__eq__` 去比（见 `schedules_equal`）
            self._heap_invalidated = True
            if changed:
                self._last_seen_update = latest
        return self._schedule

    @schedule.setter
    def schedule(self, value: dict[str, ModelEntry]) -> None:
        # celery 的 Scheduler.__init__ 会往 self.schedule 赋值，得接住
        self._schedule = value or {}

    def _carry_over_run_stats(
        self, fresh: dict[str, ModelEntry], previous: dict[str, ModelEntry]
    ) -> dict[str, ModelEntry]:
        """🔴 重读时，内存里比库里新的触发记录要带过来（#183 review）。

        触发记录由 `_persist` 当场写库，写失败只记一条 warning。原来要「恰好有人改了调度」才会重载、
        拿库里的旧值覆盖内存；有了定时重读，`reload_every` 之内必然覆盖 —— 每日任务当天再补跑一次，
        one_off 的计数回到 0 再跑一次。按 id 对（改名不影响），只带比库里新的；`sync()` 会把它补回库里。
        """
        by_id = {entry.model.id: entry.model for entry in previous.values()}
        for name, entry in list(fresh.items()):
            mem = by_id.get(entry.model.id)
            if mem is None or mem.last_run_time is None:
                continue
            if entry.model.last_run_time is None or mem.last_run_time > entry.model.last_run_time:
                entry.model.last_run_time = mem.last_run_time
                entry.model.total_run_count = mem.total_run_count
                fresh[name] = self.Entry(entry.model, app=self.app, loaded_since=self._started_at)
        return fresh

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
                        {
                            'last_run_time': m.last_run_time,
                            'total_run_count': m.total_run_count,
                            'updated_time': TaskScheduler.updated_time,  # 不动它，同 `_persist`
                        },
                        synchronize_session=False,
                    )
        except Exception as e:
            logger.warning('回写任务调度统计失败：%s', e)


__all__ = ['DatabaseScheduler', 'ModelEntry', 'is_retired', 'to_schedule']
