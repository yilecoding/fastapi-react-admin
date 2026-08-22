from fastapi import APIRouter

from backend.app.task.api.v1.result import router as result_router
from backend.app.task.api.v1.scheduler import router as scheduler_router

router = APIRouter(prefix='/tasks')

router.include_router(scheduler_router, prefix='/schedulers', tags=['任务调度'])
router.include_router(result_router, prefix='/results', tags=['任务执行记录'])
