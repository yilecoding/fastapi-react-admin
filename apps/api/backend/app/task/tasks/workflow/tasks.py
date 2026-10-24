"""审批的后台任务：超时处理（每 5 分钟，规则在 `timeout_service.py`）· AI 预审（提交后派发，`ai_review_service.py`）
+ 自动同意（`ai_approve_service.py`）"""

from backend.app.task.celery import celery_app
from backend.app.task.tasks.base import with_timeout
from backend.common.log import log
from backend.database.db import async_db_session
from backend.plugin.workflow.service.ai_approve_service import after_review
from backend.plugin.workflow.service.ai_review_service import TASK_NAME as AI_REVIEW_TASK
from backend.plugin.workflow.service.timeout_service import handle_timeouts


@celery_app.task(name='workflow.handle_timeouts')
@with_timeout()
async def handle_workflow_timeouts() -> str:
    counts = await handle_timeouts(async_db_session)
    msg = f'审批超时处理：{counts}'
    log.info(msg)
    return msg


@celery_app.task(name=AI_REVIEW_TASK)
@with_timeout(300)
async def workflow_ai_review(review_id: int) -> str:
    """AI 预审（#111 第 2 条）+ 建议通过时的自动同意（第 5 条）。

    由审批事务提交之后派发，模型调用在这里、不在审批事务里
    """
    return await after_review(async_db_session, review_id)
