from enum import StrEnum

from backend.common.enums import IntEnum


class TaskSchedulerType(IntEnum):
    """任务调度类型"""

    interval = 0
    crontab = 1


class TaskIntervalPeriod(StrEnum):
    """间隔单位。

    取值必须和 `timedelta` 的关键字一致 —— `utils/schedulers.py` 直接把它
    当 kwargs 展开（`timedelta(**{period: every})`）。加档位时对着
    `datetime.timedelta` 的签名加，别自己造词。
    """

    days = 'days'
    hours = 'hours'
    minutes = 'minutes'
    seconds = 'seconds'
    microseconds = 'microseconds'
