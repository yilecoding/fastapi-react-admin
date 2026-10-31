"""公告的收件箱对时（#190）：定时发布到点了就发、自然过期了就撤。

公告的「发」和「撤」平时都挂在管理员的写操作上（`notice_service.create / update / delete`），
只有两件事没有事件可挂，靠这个任务每 60 秒扫一次（调度在 `task_scheduler`，种子 + 迁移 `ag000000noticephase2`）：

- **定时发布到点**：显示中 · 没删 · 定过的发布时间已到 · 没过期 · 还没有挂着的收件箱行 → 广播 + 提交后推送
- **自然过期**：读者已经看不见了、收件箱行还挂着 → 撤回 + 提交后推送（#186 时点进去是「已撤回或已过期」）

幂等：重复跑不重复发 —— 每条都在自己的事务里**锁住公告再重新判一遍**（`notice_service.publish_scheduled`），
并发的两个 worker 也只有一个发得出去。
"""

from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.common.log import log
from backend.database.db import async_db_session


async def sync_inbox_once() -> dict[str, int]:
    """扫一遍：先发到点的、再撤过期的。每条一个事务，一条出错不影响别的（下一分钟再试）

    ⚠️ 自己开会话（worker 里没有依赖注入），所以这个模块登记在 conftest 的 `_PATCHED_SESSION_MODULES` 里
    """
    from backend.plugin.notice.crud.crud_notice import notice_dao
    from backend.plugin.notice.service.notice_service import notice_service

    async with async_db_session() as db:
        due = await notice_dao.get_due_ids(db)
        stale = await notice_dao.get_stale_ids(db)

    stats = {'published': 0, 'retracted': 0, 'failed': 0}
    for pk in due:
        try:
            async with async_db_session.begin() as db:
                stats['published'] += await notice_service.publish_scheduled(db=db, pk=pk)
        except Exception as e:  # ruff:ignore[try-except-in-loop]
            stats['failed'] += 1
            log.error(f'定时发布公告 {pk} 失败（下一轮再试）：{e!s}')
    for pk in stale:
        try:
            async with async_db_session.begin() as db:
                stats['retracted'] += await notice_service.retract_stale(db=db, pk=pk)
        except Exception as e:  # ruff:ignore[try-except-in-loop]
            stats['failed'] += 1
            log.error(f'撤回过期公告 {pk} 的收件箱行失败（下一轮再试）：{e!s}')
    return stats


# 🔴 每 60 秒一次的高频任务：`ignore_result` 不往执行记录写（一天 1440 行会淹没「执行记录」页），
# `notify=False` 不给所有在线页面推「开始 / 成功」提示（task 分册「高频任务的两条纪律」，同 `health.heartbeat`）
@celery_app.task(name='notice.sync_inbox', ignore_result=True, notify=False)
@with_timeout()
async def sync_inbox() -> str:
    """定时发布到点的公告、撤回过期公告的收件箱行（#190）"""
    from backend.plugin.core import check_plugin_installed

    if not check_plugin_installed('notice'):
        return '通知公告插件未安装，跳过'
    stats = await sync_inbox_once()
    changed = {k: v for k, v in stats.items() if v}
    msg = f'公告收件箱对时：{changed or "没有要发 / 要撤的"}'
    if changed:
        log.info(msg)
    return msg
