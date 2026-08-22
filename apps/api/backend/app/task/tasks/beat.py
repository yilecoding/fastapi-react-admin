"""静态 beat 调度。

第一刀的调度写在代码里，不入库 —— 改调度要发版。
下一刀会加 `task_scheduler` 表 + DatabaseScheduler，届时这里退化成
「新库的初始调度」，界面上能改的那份以库为准。
"""

from celery.schedules import crontab

LOCAL_BEAT_SCHEDULE = {
    'maintenance.prune_logs': {
        'task': 'maintenance.prune_logs',
        # 每天 03:15 —— 避开整点，整点是所有人的定时任务都在跑的时候
        'schedule': crontab(hour=3, minute=15),
        'kwargs': {'days': 30},
    },
}


def get_local_beat_schedule() -> dict:
    return LOCAL_BEAT_SCHEDULE
