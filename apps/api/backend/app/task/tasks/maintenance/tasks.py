"""运维类周期任务。

刻意从**周期任务**（crontab）起步，不从一次性定时（eta）起步：
周期任务幂等、漏跑一次下次补上、没有撤销概念；一次性定时要处理 revoke、
改期、worker 重启后 eta 任务的归属 —— 那是 celery 最容易用错的一类。
"""

from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.task.celery import celery_app
from backend.common.log import log
from backend.database.db import async_db_session
from backend.utils.timezone import timezone

#: 每批删多少行。见 `_prune_table` 的注释 —— 这个值不是性能调优，是安全阀
PRUNE_BATCH = 2000


async def _prune_table(db: AsyncSession, model, time_col, cutoff: datetime, batch: int) -> int:
    """分批删除 `time_col < cutoff` 的行，返回删掉几行。

    🔴 **必须分批，不能一条 DELETE 删到底。** 日志表是全库长得最快的表，
    跑上一年几百万行是常态。一条无界的 `DELETE ... WHERE time < x` 在
    SQL Server 上会：

    - **锁升级**：单表累计约 5000 个行锁就升级成表锁，于是清理期间
      **所有写操作日志的请求都被阻塞** —— 而每个 API 请求都写操作日志。
      表现是「凌晨三点整站卡住几分钟」，而日志里只有一条任务成功
    - **事务日志暴涨**：一次删几百万行是一个事务，日志文件按删除量增长，
      磁盘满了整个库就只读了
    - 中途失败全部回滚，白跑一趟

    分批之后每批一个独立事务，锁拿了就放，失败也只丢当前这批。

    ⚠️ 用「先查 id 再按 id 删」而不是 `DELETE TOP (n)`：后者是 T-SQL 方言，
    本仓库还要跑 MySQL / PostgreSQL（`DataBaseType` 三个值）。
    `select(...).limit(n)` 在三种方言下都成立。
    """
    total = 0
    while True:
        ids = (
            await db.execute(select(model.id).where(time_col < cutoff).order_by(model.id).limit(batch))
        ).scalars().all()
        if not ids:
            break
        total += (await db.execute(delete(model).where(model.id.in_(ids)))).rowcount or 0
        await db.commit()
        if len(ids) < batch:
            break
    return total


@celery_app.task(name='maintenance.prune_logs')
async def prune_logs(days: int = 30, batch: int = PRUNE_BATCH) -> str:
    """清理 N 天前的登录日志与操作日志。

    在这之前，界面上唯一的清理入口是「清空」—— 全删或不删，没有中间档。

    ⚠️ **按业务时间（`login_time` / `opera_time`）删，不是 `created_time`。**
    两者在同步写入时几乎一样，但操作日志是**后台消费者**批量落库的
    （`OperaLogMiddleware.consumer()`），`created_time` 会滞后于 `opera_time`。
    而界面上那两页的筛选、排序、显示**全都用业务时间** —— 用 `created_time`
    清理的话，用户看到「30 天前」的那条可能还在，看到「29 天前」的那条却没了，
    对不上账而且解释不清。
    """
    from backend.app.admin.model import LoginLog, OperaLog

    # ⚠️ backend.utils.timezone 只有 now/from_str/to_str/to_utc 那几个，没有 timedelta
    cutoff = timezone.now() - timedelta(days=days)

    async with async_db_session() as db:
        login = await _prune_table(db, LoginLog, LoginLog.login_time, cutoff, batch)
        opera = await _prune_table(db, OperaLog, OperaLog.opera_time, cutoff, batch)

    msg = f'清理 {days} 天前的日志：登录日志 {login} 条、操作日志 {opera} 条'
    log.info(msg)
    return msg
