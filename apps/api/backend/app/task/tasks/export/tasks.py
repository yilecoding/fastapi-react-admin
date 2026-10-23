"""后台导出（#11 · v0.4）。行数超过 `EXPORT_SYNC_MAX_ROWS` 时，导出接口投递 `export.run`。

生成完给发起人发一条站内消息（成功 / 失败都发：失败也得让他知道，不然他会一直等）。
消息中心是插件，没装的话就只靠「导出记录」页 —— 不让一个可选插件挡住导出本身。

🔴 **worker 不走 FastAPI 的路由装载**：各资源的导出定义（`app/admin/dataio.py`、`plugin/*/dataio.py`）
在 web 进程里是路由模块 import 时登记的，worker 里没人 import 它们 —— 不在这里显式加载，
任务一跑就是「资源不可用」。
"""

from backend.app.admin.model import ExportJob
from backend.app.admin.service.export_service import export_service
from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.common.dataio.exporting import load_dataio_modules
from backend.common.enums import ExportJobStatus
from backend.common.i18n import i18n, t
from backend.common.log import log
from backend.database.db import async_db_session
from backend.plugin.core import check_plugin_installed

load_dataio_modules()

#: 站内消息点开去哪：个人中心的「导出记录」面板
EXPORTS_LINK = '/profile?section=exports'


@celery_app.task(name='export.run')
@with_timeout()
async def run_export(job_id: str) -> str:
    """生成一份导出。`job_id` 用字符串传：雪花 ID 过 JSON 序列化，别让任何一环有机会把它当数字（硬纪律 6）"""
    job = await export_service.execute(int(job_id))
    if job is None:
        msg = f'导出 {job_id}：没抢到（别的 worker 在做，或已经结束）'
        log.info(msg)
        return msg

    await _notify(job)
    msg = f'导出 {job_id}：{ExportJobStatus(job.status).name}，{job.row_count or 0} 行'
    log.info(msg)
    return msg


async def _notify(job: ExportJob) -> None:
    """通知发起人。失败只记日志：结果已经在导出记录里了，消息只是提醒"""
    if not check_plugin_installed('notification'):
        return
    from backend.plugin.notification.enums import NotificationCategory
    from backend.plugin.notification.service.notification_service import notification_service

    ok = job.status == ExportJobStatus.succeeded.value
    with i18n.use_language(job.language):
        if ok:
            title = t('export.notify.done_title', title=job.title)
            content = t('export.notify.done_content', rows=f'{job.row_count or 0:,}', file=job.file_name)
        else:
            title = t('export.notify.failed_title', title=job.title)
            content = job.error or t('error.export.unexpected')
    try:
        async with async_db_session() as db:
            await notification_service.notify(
                db=db,
                user_id=job.created_by,
                title=title,
                content=content,
                link=EXPORTS_LINK,
                category=NotificationCategory.TASK,
            )
    except Exception as e:
        log.warning(f'导出 {job.id} 的完成通知没发出去（不影响结果）：{e!s}')
