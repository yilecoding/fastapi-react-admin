from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession
from backend.plugin.open.schema.api_log import GetOpenApiLogDetail
from backend.plugin.open.service.api_log_service import open_api_log_service

router = APIRouter()


@router.get(
    '',
    summary='分页获取开放接口调用日志',
    dependencies=[Depends(RequestPermission('open:log:list')), DependsRBAC, DependsPagination],
)
async def get_open_api_logs_paginated(
    db: CurrentSession,
    app_id: Annotated[int | None, Query(description='应用 ID')] = None,
    status: Annotated[int | None, Query(description='结果（0：失败、1：成功）')] = None,
    error_code: Annotated[str | None, Query(description='失败原因（open.sign_mismatch…）')] = None,
    path: Annotated[str | None, Query(description='接口路径（模糊）')] = None,
    ip: Annotated[str | None, Query(description='来源 IP（模糊）')] = None,
    start_time: Annotated[datetime | None, Query(description='调用时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='调用时间止')] = None,
) -> ResponseSchemaModel[PageData[GetOpenApiLogDetail]]:
    page_data = await open_api_log_service.get_list(
        db=db,
        app_id=app_id,
        status=status,
        error_code=error_code,
        path=path,
        ip=ip,
        start_time=start_time,
        end_time=end_time,
    )
    return response_base.success(data=page_data)
