"""任务结果表（celery DatabaseBackend 的落库目标）。

重写 `celery.backends.database.models` 里的模型 —— 上游重写是为了
「适配 fba 建表和 alembic 迁移」，我们在它基础上再修**三处 SQL Server 的账**，
每一处漏了都是静默出错：

| 上游写法 | 在 SQL Server 上会怎样 | 这里改成 |
|---|---|---|
| `traceback = sa.Text` | `sa.Text` 在 mssql 方言下映射成 **VARCHAR(max)** 而不是 NVARCHAR —— 我们的报错信息是中文（`tm()` 翻过的 msg），栈里的中文会变问号 | `UniversalText` |
| `task_id = sa.String(155), unique=True` 且**可空** | SQL Server 认为多个 NULL **相等**，第二条 task_id 为空的记录就撞唯一约束 | 筛选唯一索引 `WHERE task_id IS NOT NULL` |
| `sa.Integer + sa.Sequence + autoincrement` | Sequence 和 IDENTITY 是两套自增机制，一起用会打架 | 去掉 Sequence，纯 IDENTITY |

🔴 **这两张表刻意不用全仓的雪花主键**（`id_key`），是唯一的例外。
雪花号要 `snowflake.init()`，而那一步在 FastAPI 的 lifespan 里 —— **celery worker
根本不跑 lifespan**。实测：任务一执行就
`ServerError: 雪花 ID 生成失败，雪花算法未初始化`，而且这个异常发生在
**写结果行**的时候，于是「失败」本身也记不下来，日志里只剩
celery_aio_pool 抛的 `'NoneType' object has no attribute 'tb_frame'`（它的错误
处理路径在异常没有 `__traceback__` 时会自己崩，把真因盖掉）。

worker 侧的雪花初始化仍然要做（业务任务写自己的表时需要，见 `celery.py` 的
`worker_process_init`），但**这两张表不该依赖它** —— 让「记录一次失败」
依赖另一套初始化成功，等于雪花一挂就连失败都记不下来。
它们是 celery 的管道，真正的键是 `task_id`（uuid），自增 id 够用。
"""

import sqlalchemy as sa

from celery import states
from sqlalchemy.types import PickleType

from backend.common.model import MappedBase, TimeZone, UniversalStr, UniversalText
from backend.utils.timezone import timezone


class Task(MappedBase):
    """任务结果"""

    __tablename__ = 'task_result'
    __table_args__ = (
        # 🔴 不能用 UniqueConstraint：task_id 可空，而 SQL Server 认为多个 NULL 相等
        sa.Index(
            'uk_task_result_task_id',
            'task_id',
            unique=True,
            mssql_where=sa.text('task_id IS NOT NULL'),
            sqlite_where=sa.text('task_id IS NOT NULL'),
            postgresql_where=sa.text('task_id IS NOT NULL'),
        ),
        {'comment': '任务结果表'},
    )

    id = sa.Column(sa.BigInteger, primary_key=True, autoincrement=True, comment='主键 ID')
    task_id = sa.Column(UniversalStr(155), comment='任务 UUID')
    status = sa.Column(UniversalStr(64), default=states.PENDING, comment='任务状态')
    result = sa.Column(PickleType, nullable=True, comment='任务返回值')
    # index：`maintenance.prune_task_results` 按它做范围删除，而这张表是
    # 每执行一次任务就长一行的表 —— 没索引就是全表扫（同两个日志表那条）
    date_done = sa.Column(
        TimeZone, default=timezone.now, onupdate=timezone.now, nullable=True, index=True, comment='结束时间'
    )
    traceback = sa.Column(UniversalText, nullable=True, comment='异常栈')

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id

    def to_dict(self) -> dict:
        return {
            'task_id': self.task_id,
            'status': self.status,
            'result': self.result,
            'traceback': self.traceback,
            'date_done': self.date_done,
        }

    def __repr__(self) -> str:
        return f'<Task {self.task_id} state: {self.status}>'

    @classmethod
    def configure(cls, schema=None, name=None) -> None:  # ruff:ignore[missing-type-function-argument]
        cls.__table__.schema = schema
        cls.__table__.name = name or cls.__tablename__


class TaskExtended(Task):
    """任务结果（`result_extended=True` 时多出来的列）"""

    __tablename__ = 'task_result'
    __table_args__ = {'extend_existing': True, 'comment': '任务结果表'}

    name = sa.Column(UniversalStr(155), nullable=True, comment='任务名')
    args = sa.Column(sa.LargeBinary, nullable=True, comment='位置参数')
    kwargs = sa.Column(sa.LargeBinary, nullable=True, comment='关键字参数')
    worker = sa.Column(UniversalStr(155), nullable=True, comment='执行的 worker')
    retries = sa.Column(sa.Integer, nullable=True, comment='重试次数')
    queue = sa.Column(UniversalStr(155), nullable=True, comment='队列')

    def to_dict(self) -> dict:
        d = super().to_dict()
        d.update({
            'name': self.name,
            'args': self.args,
            'kwargs': self.kwargs,
            'worker': self.worker,
            'retries': self.retries,
            'queue': self.queue,
        })
        return d


class TaskSet(MappedBase):
    """任务集结果（celery group 用；界面上不展示，但 DatabaseBackend 要它存在）"""

    __tablename__ = 'task_set_result'
    __table_args__ = (
        # 同 Task.task_id —— 可空列上的唯一约束在 SQL Server 下会被多个 NULL 撞到
        sa.Index(
            'uk_task_set_result_taskset_id',
            'taskset_id',
            unique=True,
            mssql_where=sa.text('taskset_id IS NOT NULL'),
            sqlite_where=sa.text('taskset_id IS NOT NULL'),
            postgresql_where=sa.text('taskset_id IS NOT NULL'),
        ),
        {'comment': '任务集结果表'},
    )

    id = sa.Column(sa.BigInteger, primary_key=True, autoincrement=True, comment='主键 ID')
    taskset_id = sa.Column(UniversalStr(155), comment='任务集 UUID')
    result = sa.Column(PickleType, nullable=True, comment='任务集返回值')
    date_done = sa.Column(TimeZone, default=timezone.now, nullable=True, comment='结束时间')

    def __init__(self, taskset_id, result) -> None:  # ruff:ignore[missing-type-function-argument]
        self.taskset_id = taskset_id
        self.result = result

    def to_dict(self) -> dict:
        return {'taskset_id': self.taskset_id, 'result': self.result, 'date_done': self.date_done}

    def __repr__(self) -> str:
        return f'<TaskSet: {self.taskset_id}>'

    @classmethod
    def configure(cls, schema=None, name=None) -> None:  # ruff:ignore[missing-type-function-argument]
        cls.__table__.schema = schema
        cls.__table__.name = name or cls.__tablename__
