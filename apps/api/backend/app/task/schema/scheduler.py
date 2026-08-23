"""任务调度的 DTO。

🔴 **校验放在这一层，不放前端。** 配错的调度不像配错的筛选条件 ——
它会**自己跑**。一条段数写错的 crontab 如果被存进库，`all_as_schedule`
只能跳过它（否则整个 beat 起不来），于是界面上那条调度看着是启用的、
实际永远不触发，而且没有任何地方告诉你为什么。所以在写入口就拦住。
"""

import json

from datetime import datetime
from typing import Self

from celery.schedules import crontab as celery_crontab
from pydantic import ConfigDict, Field, field_validator, model_validator

from backend.app.task.enums import TaskIntervalPeriod, TaskSchedulerType
from backend.common.schema import SchemaBase


class TaskSchedulerSchemaBase(SchemaBase):
    """任务调度基础模型"""

    name: str = Field(description='任务名称', min_length=1, max_length=64)
    task: str = Field(description='要运行的 Celery 任务（注册名）', min_length=1, max_length=256)
    type: TaskSchedulerType = Field(TaskSchedulerType.crontab, description='调度类型（0：间隔、1：定时）')

    crontab: str = Field('* * * * *', description='Crontab 表达式（type=1 时用）')
    interval_every: int | None = Field(None, description='间隔数（type=0 时用）', gt=0)
    interval_period: TaskIntervalPeriod | None = Field(None, description='间隔单位（type=0 时用）')

    args: str | None = Field(None, description='位置参数（JSON 数组）')
    kwargs: str | None = Field(None, description='关键字参数（JSON 对象）')
    queue: str | None = Field(None, description='队列', max_length=256)
    exchange: str | None = Field(None, description='AMQP 交换机', max_length=256)
    routing_key: str | None = Field(None, description='AMQP 路由键', max_length=256)

    start_time: datetime | None = Field(None, description='开始触发时间')
    expire_time: datetime | None = Field(None, description='截止触发时间')
    expire_seconds: int | None = Field(None, description='相对截止秒数', gt=0)

    one_off: bool = Field(False, description='是否只运行一次')
    enabled: bool = Field(True, description='是否启用')
    remark: str | None = Field(None, description='备注')

    @field_validator('args')
    @classmethod
    def check_args(cls, v: str | None) -> str | None:
        """args 必须是 JSON **数组** —— celery 按位置展开它"""
        if v in (None, ''):
            return None
        try:
            parsed = json.loads(v)
        except (TypeError, ValueError) as e:
            raise ValueError(f'位置参数不是合法 JSON：{e}') from e
        if not isinstance(parsed, list):
            # pydantic 只把 ValueError 转成校验错误，TypeError 会原样冒出去变成 500
            raise ValueError('位置参数必须是 JSON 数组，例如 [1, "a"]')  # ruff:ignore[type-check-without-type-error]
        return v

    @field_validator('kwargs')
    @classmethod
    def check_kwargs(cls, v: str | None) -> str | None:
        """kwargs 必须是 JSON **对象** —— celery 按关键字展开它"""
        if v in (None, ''):
            return None
        try:
            parsed = json.loads(v)
        except (TypeError, ValueError) as e:
            raise ValueError(f'关键字参数不是合法 JSON：{e}') from e
        if not isinstance(parsed, dict):
            # 同上：这里必须是 ValueError
            raise ValueError('关键字参数必须是 JSON 对象，例如 {"days": 30}')  # ruff:ignore[type-check-without-type-error]
        return v

    @model_validator(mode='after')
    def check_schedule(self) -> Self:
        """按调度类型校验对应的那一组字段。

        ⚠️ crontab 交给 celery 自己解析而不是自己写正则：`*/5`、`1-5`、
        `mon-fri`、`1,15` 这些写法各有各的规矩，手写正则一定会漏，
        而漏掉的结果是「存进去了但永远不触发」。
        """
        if self.type == TaskSchedulerType.crontab:
            parts = (self.crontab or '').split()
            if len(parts) != 5:
                raise ValueError(f'Crontab 表达式必须是 5 段（分 时 日 月 周），收到 {self.crontab!r}')
            try:
                celery_crontab(
                    minute=parts[0], hour=parts[1], day_of_month=parts[2],
                    month_of_year=parts[3], day_of_week=parts[4],
                )
            except Exception as e:
                raise ValueError(f'Crontab 表达式无效：{e}') from e
        else:
            if not self.interval_every or not self.interval_period:
                raise ValueError('间隔调度必须同时填写间隔数与间隔单位')

        # 与模型层 before_insert_or_update 同一条规则，在这里先报，
        # 免得等到 flush 才抛 ConflictError（那时报错位置离用户很远）
        if self.expire_seconds is not None and self.expire_time is not None:
            raise ValueError('截止时间与截止秒数只能设置一个')

        if self.start_time and self.expire_time and self.start_time >= self.expire_time:
            raise ValueError('开始时间必须早于截止时间')

        return self


class CreateTaskSchedulerParam(TaskSchedulerSchemaBase):
    """创建任务调度参数"""


class UpdateTaskSchedulerParam(TaskSchedulerSchemaBase):
    """更新任务调度参数"""


class DeleteTaskSchedulerParam(SchemaBase):
    """删除任务调度参数"""

    pks: list[int] = Field(description='任务调度 ID 列表')


class GetTaskSchedulerDetail(TaskSchedulerSchemaBase):
    """任务调度详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='任务调度 ID')
    total_run_count: int = Field(0, description='累计触发次数')
    last_run_time: datetime | None = Field(None, description='最近触发时间')
    created_time: datetime = Field(description='创建时间')
    updated_time: datetime | None = Field(None, description='更新时间')


class GetTaskResultDetail(SchemaBase):
    """任务执行记录详情"""

    model_config = ConfigDict(from_attributes=True)

    id: int = Field(description='记录 ID')
    task_id: str | None = Field(None, description='任务 UUID')
    name: str | None = Field(None, description='任务名')
    status: str | None = Field(None, description='状态')
    result: str | None = Field(None, description='返回值')
    traceback: str | None = Field(None, description='异常栈')
    retries: int | None = Field(None, description='重试次数')
    worker: str | None = Field(None, description='执行的 worker')
    queue: str | None = Field(None, description='队列')
    date_done: datetime | None = Field(None, description='结束时间')


class DeleteTaskResultParam(SchemaBase):
    """删除任务执行记录参数"""

    pks: list[int] = Field(description='记录 ID 列表')


class TaskSchedulerMeta(SchemaBase):
    """调度运行时元信息"""

    tasks: list[str] = Field(description='已注册的 Celery 任务名')
    timezone: str = Field(description='beat 解释 crontab 用的时区（IANA），前端算执行时间预览要用它')
