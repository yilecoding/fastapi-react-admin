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

from datetime import datetime

import sqlalchemy as sa

from sqlalchemy import event
from sqlalchemy.orm import Mapped, mapped_column

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.model import Base, TimeZone, UniversalStr, UniversalText, id_key


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
        if not target.no_changes:
            cls.touch_last_update()

    @classmethod
    def touch_last_update(cls, *args, **kwargs) -> None:
        """打一个「调度变了」的时间戳，beat 靠轮询它决定要不要重载。

        🔴 这里**不能**用 `asyncio.create_task`（上游是那么写的）：
        SQLAlchemy 的 ORM 事件是同步回调，而 celery beat / worker 进程里
        常常没有运行中的事件循环 —— `create_task` 会抛
        `RuntimeError: no running event loop`，把一次本来成功的保存
        变成 500，而用户看到的是「改调度失败」，跟调度本身毫无关系。
        """
        import asyncio

        from backend.core.conf import settings
        from backend.database.redis import redis_client
        from backend.utils.timezone import timezone

        key = f'{settings.CELERY_REDIS_PREFIX}:last_update'
        value = timezone.to_str(timezone.now())
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # 没有事件循环（beat / worker / 同步脚本）—— 起一个临时的写完就走
            asyncio.run(redis_client.set(key, value))
        else:
            loop.create_task(redis_client.set(key, value))


event.listen(TaskScheduler, 'before_insert', TaskScheduler.before_insert_or_update)
event.listen(TaskScheduler, 'before_update', TaskScheduler.before_insert_or_update)
event.listen(TaskScheduler, 'after_insert', TaskScheduler.changed)
event.listen(TaskScheduler, 'after_update', TaskScheduler.changed)
event.listen(TaskScheduler, 'after_delete', TaskScheduler.changed)
