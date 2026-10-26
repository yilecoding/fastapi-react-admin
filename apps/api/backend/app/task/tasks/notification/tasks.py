"""每日问候。

顺带验证消息中心链路是否通畅（落库 → 未读数 → socket 推送 → 前端红点），
但**用户看到的是产品向的问候语，不是一句"探针/测试"字样**——这条会一直跑下去，
不是临时调试脚手架，文案要经得起长期展示。
"""

import random

from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.common.log import log
from backend.database.db import async_db_session
from backend.plugin.notification.enums import NotificationCategory
from backend.plugin.notification.service.notification_service import notification_service
from backend.utils.timezone import timezone

#: 问候语池。每天随机挑一条而不是固定一句，纯粹是为了不让人看腻——
#: 内容本身不区分工作日/周末，选纯天气/心情向的通用文案，避免「周一加油」
#: 撞上真的周三这种尴尬
_GREETINGS = (
    '新的一天，从查收消息开始，祝你今天工作顺利。',
    '早安，别忘了看一眼今天的待办，轻装上阵。',
    '愿你今天的心情，像晴天一样明朗。',
    '工作再忙，也要记得喝水、按时休息。',
    '今天也要元气满满，诸事顺利。',
    '新的一天，新的开始，愿你所有的努力都有回报。',
    '早上好，今天的你，比昨天更进一步。',
    '别忘了对自己好一点，工作与生活都值得被认真对待。',
)


@celery_app.task(name='notification.send_daily_greeting')
@with_timeout()
async def send_daily_greeting() -> str:
    """每天挑一条问候语，给全员广播一次。"""
    today = timezone.now()
    greeting = random.choice(_GREETINGS)

    async with async_db_session() as db:
        await notification_service.broadcast(
            db=db,
            title=f'每日问候 · {today.strftime("%m月%d日")}',
            content=greeting,
            category=NotificationCategory.SYSTEM,
            kind='system.greeting',
        )
        await db.commit()

    msg = f'每日问候已发送（{timezone.to_str(today)}）：{greeting}'
    log.info(msg)
    return msg


@celery_app.task(name='notification.deliver_pending')
@with_timeout()
async def deliver_pending() -> str:
    """把到点的通知投递发出去（邮件 / 短信，#166）。

    每 15 秒由 beat 派一次（安全网），写了待发行的事务提交后也会立刻踢一次（`delivery_service.kick`）。
    幂等：两个 worker 同时跑，每一行只有抢到的那一个发（`claim` 看 rowcount）。
    """
    from backend.plugin.core import check_plugin_installed

    if not check_plugin_installed('notification'):
        return '通知插件未安装，跳过'
    from backend.plugin.notification.service.delivery_service import deliver_pending as run

    stats = await run()
    msg = f'通知投递：{stats or "没有到点的"}'
    if stats:
        log.info(msg)
    return msg
