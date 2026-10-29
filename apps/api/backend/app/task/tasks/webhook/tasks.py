"""Webhook 投递（#167）。能力开放插件的事，放在这里是因为 Celery 只扫 `app/task/tasks/*/tasks.py`"""

from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.common.log import log


# 每 15 秒一次：不写执行记录、不推提示（同 `notification.deliver_pending`）
@celery_app.task(name='open.webhook_deliver_pending', ignore_result=True, notify=False)
@with_timeout()
async def deliver_pending() -> str:
    """把到点的 Webhook 投递发出去。

    每 15 秒由 beat 派一次（安全网），写了投递行的事务提交后也会立刻踢一次（`event_service.kick_after_commit`）。
    幂等：两个 worker 同时跑，每一行只有抢到的那一个发（`claim` 看 rowcount）。
    """
    from backend.plugin.core import check_plugin_installed

    if not check_plugin_installed('open'):
        return '能力开放插件未安装，跳过'
    from backend.plugin.open.events import load_webhook_extensions
    from backend.plugin.open.service.webhook_delivery import deliver_pending as run

    load_webhook_extensions()
    stats = await run()
    msg = f'Webhook 投递：{stats or "没有到点的"}'
    if stats:
        log.info(msg)
    return msg
