"""运维类周期任务。

刻意从**周期任务**（crontab）起步，不从一次性定时（eta）起步：
周期任务幂等、漏跑一次下次补上、没有撤销概念；一次性定时要处理 revoke、
改期、worker 重启后 eta 任务的归属 —— 那是 celery 最容易用错的一类。
"""

from datetime import timedelta

from backend.app.task.celery import celery_app
from backend.common.log import log
from backend.database.db import async_db_session
from backend.utils.timezone import timezone


@celery_app.task(name='maintenance.prune_logs')
async def prune_logs(days: int = 30) -> str:
    """清理 N 天前的登录日志与操作日志。

    在这之前，界面上唯一的清理入口是「清空」—— 全删或不删，没有中间档。
    """
    from sqlalchemy import delete

    from backend.app.admin.model import LoginLog, OperaLog

    # ⚠️ backend.utils.timezone 只有 now/from_str/to_str/to_utc 那几个，没有 timedelta
    cutoff = timezone.now() - timedelta(days=days)
    async with async_db_session.begin() as db:
        login = (await db.execute(delete(LoginLog).where(LoginLog.created_time < cutoff))).rowcount
        opera = (await db.execute(delete(OperaLog).where(OperaLog.created_time < cutoff))).rowcount

    msg = f'清理 {days} 天前的日志：登录日志 {login} 条、操作日志 {opera} 条'
    log.info(msg)
    return msg
