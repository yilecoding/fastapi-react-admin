"""审批超时处理（提醒 / 自动同意 / 自动驳回），每 5 分钟一次。规则在 `plugin/workflow/service/timeout_service.py`"""

from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.common.log import log
from backend.database.db import async_db_session
from backend.plugin.workflow.service.timeout_service import handle_timeouts


@celery_app.task(name='workflow.handle_timeouts')
@with_timeout()
async def handle_workflow_timeouts() -> str:
    counts = await handle_timeouts(async_db_session)
    msg = f'审批超时处理：{counts}'
    log.info(msg)
    return msg
