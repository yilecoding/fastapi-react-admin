from fastapi import APIRouter

from backend.core.conf import settings
from backend.plugin.open.api.open_v1.sync import router as sync_router
from backend.plugin.open.api.v1.api_log import router as api_log_router
from backend.plugin.open.api.v1.app import router as app_router

# 管理接口：后台登录 + RBAC
v1 = APIRouter(prefix=settings.FASTAPI_API_V1_PATH)
v1.include_router(app_router, prefix='/open-apps', tags=['能力开放应用'])
v1.include_router(api_log_router, prefix='/open-api-logs', tags=['能力开放调用日志'])

# 开放接口：AK/SK 签名（`gateway/auth.py`），不经过 JWT / RBAC。前缀刻意不在 /api/v1 下：
# 内部接口没有兼容承诺（跟着 gen:api 随时改），对外的这一组有
open_v1 = APIRouter(prefix='/api/open/v1')
open_v1.include_router(sync_router, tags=['开放接口'])
