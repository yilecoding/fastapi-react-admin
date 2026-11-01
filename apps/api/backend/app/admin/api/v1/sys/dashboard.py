from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from backend.app.admin.service import dashboard_service
from backend.common.response.response_schema import ResponseModel, response_base
from backend.common.schema import IanaTimeZone
from backend.common.security.jwt import DependsJwtAuth, DependsSuperUser
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession

router = APIRouter()

# 工作台「系统运行」区（#202）。三块各一个接口：一块挂了只影响那一张卡片


@router.get('/attention', summary='需要你留意的异常（按各条目自己的权限过滤）', dependencies=[DependsJwtAuth])
async def get_attention(request: Request, db: CurrentSession) -> ResponseModel:
    # 只挂登录：一个总权限码挡不住「看得到定时任务、看不到 Webhook」这种组合，过滤在 service 里逐条做
    return response_base.success(data=await dashboard_service.attention(db, request.user))


@router.get('/services', summary='服务状态 + 在线会话（按端）', dependencies=[DependsSuperUser])
async def get_services() -> ResponseModel:
    # 超管：在线会话来自会话索引，和在线用户页（`/monitors/sessions`）同一个门槛
    return response_base.success(data=await dashboard_service.services())


@router.get(
    '/visits',
    summary='近 N 天每天的登录成功 / 失败次数',
    dependencies=[Depends(RequestPermission('log:login:list')), DependsRBAC],
)
async def get_visits(
    db: CurrentSession,
    days: Annotated[int, Query(ge=1, le=dashboard_service.VISITS_MAX_DAYS, description='看几天（含今天）')] = 14,
    tz: Annotated[IanaTimeZone | None, Query(description='按哪个时区切「哪一天」，不传 = 服务端时区')] = None,
) -> ResponseModel:
    return response_base.success(data=await dashboard_service.visits(db, days=days, tz=tz))
