r"""任务调度表 —— beat 从这里读要跑什么、什么时候跑。

有了它，调度才是**界面上能改的数据**，而不是写死在 `tasks/beat.py` 里、
改一次要发一次版的常量。

与上游 `backend/app/task/model/scheduler.py` 的差异，全部是 SQL Server 的账：

| 上游 | 问题 | 这里 |
|---|---|---|
| `name = sa.String(64)` | 任务名称会存中文，`sa.String` 在 mssql 下是 VARCHAR，按代码页截断/乱码 | `UniversalStr(64)` |
| `args/kwargs = sa.JSON()` | 类型注解写的是 `str \| None`，和 JSON 实际返回的 dict/list 对不上；mssql 下 SQLAlchemy 把 JSON 映射成 NVARCHAR(max)，等于就是字符串 | `UniversalText` + 注解如实写成 str |
| `asyncio.create_task(...)` 在 SQLAlchemy 同步事件里 | beat/worker 进程里常常**没有运行中的事件循环**，`create_task` 直接抛 RuntimeError，把一次正常的保存变成 500 | 捕获 RuntimeError，退化成同步写 Redis |

`(name, deleted)` 的唯一约束**可以**建在库上：两列都非空，不触发
「SQL Server 认为多个 NULL 相等」那条坑（对比部门表的同级重名，那里
`parent_id` 可空，所以只能在 service 层拦）。
"""

import asyncio
import uuid

from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa

from sqlalchemy import event
from sqlalchemy.orm import Mapped, Session, mapped_column, object_session

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.model import Base, TimeZone, UniversalStr, UniversalText, id_key

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

_TOUCH_PENDING = 'task_scheduler_touch_pending'
_TOUCH_LISTENING = 'task_scheduler_touch_listening'

# create_task 出去的写 Redis 任务要有人拿着引用，否则可能没跑完就被回收
_background: set[asyncio.Task] = set()


class TaskScheduler(Base):
    """任务调度表"""

    __tablename__ = 'task_scheduler'
    __table_args__ = (
        sa.UniqueConstraint('name', 'deleted', name='uk_task_scheduler_name_deleted'),
        {'comment': '任务调度表'},
    )

    id: Mapped[id_key] = mapped_column(init=False)
    name: Mapped[str] = mapped_column(UniversalStr(64), comment='任务名称')
    task: Mapped[str] = mapped_column(sa.String(256), comment='要运行的 Celery 任务（注册名）')
    args: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='位置参数（JSON 数组）')
    kwargs: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='关键字参数（JSON 对象）')
    queue: Mapped[str | None] = mapped_column(sa.String(256), default=None, comment='队列')
    exchange: Mapped[str | None] = mapped_column(sa.String(256), default=None, comment='AMQP 交换机')
    routing_key: Mapped[str | None] = mapped_column(sa.String(256), default=None, comment='AMQP 路由键')
    start_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='开始触发时间')
    expire_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='截止触发时间')
    expire_seconds: Mapped[int | None] = mapped_column(default=None, comment='相对截止秒数')
    type: Mapped[int] = mapped_column(default=1, comment='调度类型（0：间隔、1：定时）')
    interval_every: Mapped[int | None] = mapped_column(default=None, comment='间隔数')
    interval_period: Mapped[str | None] = mapped_column(sa.String(32), default=None, comment='间隔单位')
    crontab: Mapped[str] = mapped_column(sa.String(64), default='* * * * *', comment='Crontab 表达式')
    one_off: Mapped[bool] = mapped_column(default=False, comment='是否只运行一次')
    enabled: Mapped[bool] = mapped_column(default=True, comment='是否启用')
    total_run_count: Mapped[int] = mapped_column(default=0, comment='累计触发次数')
    last_run_time: Mapped[datetime | None] = mapped_column(TimeZone, default=None, comment='最近触发时间')
    remark: Mapped[str | None] = mapped_column(UniversalText, default=None, comment='备注')

    # DatabaseScheduler 回写 total_run_count / last_run_time 时置 True，
    # 避免把自己的写入也当成「用户改了调度」而触发 beat 重载
    no_changes: bool = False

    @staticmethod
    def before_insert_or_update(mapper, connection, target) -> None:  # ruff:ignore[missing-type-function-argument]
        if target.expire_seconds is not None and target.expire_time:
            raise errors.ConflictError(msg=t('error.task.deadline_conflict'))

    @classmethod
    def changed(cls, mapper, connection, target) -> None:  # ruff:ignore[missing-type-function-argument]
        # 🔴 这里是 flush 里、提交**前**：当场打标记的话 beat 可能抢先重载读到旧行（SQL Server 上那次读还会
        # 被这条未提交的 INSERT 挡住），所以也只登记、等提交之后再打（#183）
        if not target.no_changes:
            _touch_after_commit_of(object_session(target))

    @classmethod
    def touch_last_update(cls, *args, **kwargs) -> None:
        """打一个「调度变了」的标记，beat 靠轮询它决定要不要重载。

        🔴 这里**不能**用 `asyncio.create_task`（上游是那么写的）：
        SQLAlchemy 的 ORM 事件是同步回调，而 celery beat / worker 进程里
        常常没有运行中的事件循环 —— `create_task` 会抛
        `RuntimeError: no running event loop`，把一次本来成功的保存
        变成 500，而用户看到的是「改调度失败」，跟调度本身毫无关系。

        🔴 **每次的值必须不同**（#183）。beat 只比「和上次读到的相不相等」，原来写的是
        `to_str(now())`、只到秒：同一秒里的两次改动（开关连点两下）写出同一个值，
        第二次 beat 看不出来，停在第一次的状态。
        时间留着是给人排查用的（看这个键停在哪天），后缀才是保证不重复的那部分。
        """
        from backend.core.conf import settings
        from backend.utils.timezone import timezone

        key = f'{settings.CELERY_REDIS_PREFIX}:last_update'
        value = f'{timezone.now().isoformat()} {uuid.uuid4().hex[:8]}'
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 没有事件循环（beat / worker / 同步脚本）—— 起一个临时的写完就走
            asyncio.run(_write_marker(key, value))
        else:
            task = loop.create_task(_write_marker(key, value))
            _background.add(task)
            task.add_done_callback(_background.discard)

    @classmethod
    def touch_last_update_after_commit(cls, db: 'AsyncSession') -> None:
        """事务提交之后再打变更标记。DAO 的增 / 改 / 启停 / 删都要调它（#183）。

        🔴 **不能只靠下面那几个 ORM 事件。** crud 的 `update_model_by_column` /
        `delete_model_by_column` 发的是 Core 的 `UPDATE ... WHERE`，**不触发 mapper 事件**
        —— 页面上的启停、编辑、删除从来没打过标记，beat 一直按老配置跑到下次重启。
        只有新建走 `session.add`，事件才会响。

        🔴 **必须在提交之后打。** 提交前打，beat 可能抢在提交前重载、读到旧行，
        再把这个标记记成「看过了」—— 这次改动就丢了，直到下一次有人改调度。
        路由的事务在依赖退出时才提交，所以挂在 session 的 `after_commit` 上
        （同 `plugin/open/service/event_service.py: kick_after_commit`）。回滚就不打。
        """
        _touch_after_commit_of(db.sync_session)


async def _write_marker(key: str, value: str) -> None:
    """写失败只记 warning：数据已经提交了，不能为了一个标记把保存变成 500；
    beat 的定时重读会补上（`DatabaseScheduler.reload_every`）。

    ⚠️ 错误要在协程**里面**接住：有事件循环时它是 `create_task` 出去的，外面那层
    try 接不到，只会剩一句 asyncio 的「Task exception was never retrieved」。
    """
    from backend.common.log import log
    from backend.database.redis import redis_client

    try:
        await redis_client.set(key, value)
    except Exception as e:
        log.warning(f'打任务调度变更标记失败（beat 定时重读时会补上）：{e!s}')


def _touch_after_commit_of(sync: Session) -> None:
    """登记「这个会话提交之后要打一次变更标记」。同一个会话只挂一次监听；回滚就把登记清掉"""
    sync.info[_TOUCH_PENDING] = True
    if sync.info.get(_TOUCH_LISTENING):
        return
    sync.info[_TOUCH_LISTENING] = True
    event.listen(sync, 'after_commit', _touch_after_commit)
    event.listen(sync, 'after_rollback', _drop_pending_touch)


def _touch_after_commit(session: Session) -> None:
    if session.info.pop(_TOUCH_PENDING, False):
        TaskScheduler.touch_last_update()


def _drop_pending_touch(session: Session) -> None:
    session.info.pop(_TOUCH_PENDING, None)


event.listen(TaskScheduler, 'before_insert', TaskScheduler.before_insert_or_update)
event.listen(TaskScheduler, 'before_update', TaskScheduler.before_insert_or_update)
# ⚠️ 下面三个只管得到 ORM 写法（`session.add` / 改实例属性再 flush），crud 的按列更新 / 删除是 Core 语句，
# 一个都不触发 —— 主路径是 DAO 调 `touch_last_update_after_commit`，这里只是兜底（同样等提交之后才打）
event.listen(TaskScheduler, 'after_insert', TaskScheduler.changed)
event.listen(TaskScheduler, 'after_update', TaskScheduler.changed)
event.listen(TaskScheduler, 'after_delete', TaskScheduler.changed)
