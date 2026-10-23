"""worker 心跳 —— 让「worker 挂了」从外面看得见。

worker 挂掉时网页照常能开、`/health/ready` 照常 200，但定时清理、导出、通知、审批超时
全停，而且没有任何一处报错。这个任务每 60 秒由 beat 派发、worker 执行，
往 Redis 写一个时间戳，`/health/status` 读它（`core/registrar.py`）。

**写得进来 = beat 在派发 · broker 收得到消息 · worker 在消费**，任何一环断了时间戳就停住。
beat 自己另有一个心跳（`utils/schedulers.py: DatabaseScheduler.write_heartbeat`），
两个对照着看才分得清是 beat 停了还是 worker 停了。

调度在种子 SQL / 迁移 `u0000000health` 里（`task_scheduler` 表，和其他调度同一个来源）。
"""

import time

from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.core.conf import settings
from backend.database.redis import redis_client


# 🔴 两个选项都不能省，每分钟一次会把两处刷爆：
# - `ignore_result=True`：否则每次往 `task_result` 写一行 —— 一天 1440 行，「执行记录」页
#   被心跳淹没，真任务翻不出来
# - `notify=False`：`TaskBase` 的开始 / 成功提示经 socket.io 广播给**所有**在线页面，见 `tasks/base.py`
@celery_app.task(name='health.heartbeat', ignore_result=True, notify=False)
@with_timeout(10)
async def heartbeat() -> None:
    """写心跳时间戳（epoch 秒）。

    ⚠️ 用 `time.time()` 而不是 `timezone.now()`：读的一方只做减法算「距今几秒」，
    epoch 秒与时区无关。
    """
    await redis_client.set(settings.WORKER_HEARTBEAT_REDIS_KEY, f'{time.time():.3f}')
