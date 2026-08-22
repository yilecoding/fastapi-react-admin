from fastapi import APIRouter

from backend.app.task.api.v1 import router as v1_router
from backend.core.conf import settings

v1 = APIRouter(prefix=settings.FASTAPI_API_V1_PATH)

v1.include_router(v1_router)
