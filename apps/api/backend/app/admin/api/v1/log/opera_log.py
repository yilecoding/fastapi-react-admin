from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from backend.app.admin.dataio import OPERA_LOG_EXPORT
from backend.app.admin.schema.export_job import GetExportJobDetail, StartExportParam
from backend.app.admin.schema.opera_log import DeleteOperaLogParam, GetOperaLogDetail
from backend.app.admin.service.export_service import export_service
from backend.app.admin.service.opera_log_service import opera_log_service
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.get(
    '',
    summary='分页获取操作日志',
    dependencies=[
        Depends(RequestPermission('log:opera:list')),
        DependsRBAC,
        DependsPagination,
    ],
)
async def get_opera_logs_paginated(
    db: CurrentSession,
    username: Annotated[str | None, Query(description='用户名')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
    ip: Annotated[str | None, Query(description='IP 地址')] = None,
    start_time: Annotated[datetime | None, Query(description='操作时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='操作时间止')] = None,
) -> ResponseSchemaModel[PageData[GetOperaLogDetail]]:
    page_data = await opera_log_service.get_list(
        db=db, username=username, status=status, ip=ip, start_time=start_time, end_time=end_time
    )

    return response_base.success(data=page_data)


@router.post(
    '/export',
    summary='导出操作日志',
    dependencies=[Depends(RequestPermission('log:opera:export')), DependsRBAC],
)
async def export_opera_logs(
    request: Request, db: CurrentSession, obj: StartExportParam
) -> ResponseSchemaModel[GetExportJobDetail]:
    # 小批量当场生成完才返回（status=2，前端直接下载）；大批量返回排队（status=0），生成完发站内消息
    data = await export_service.start(db=db, request=request, spec=OPERA_LOG_EXPORT, obj=obj)
    return response_base.success(data=data)


@router.delete(
    '',
    summary='批量删除操作日志',
    dependencies=[
        Depends(RequestPermission('log:opera:del')),
        DependsRBAC,
    ],
)
async def delete_opera_logs(db: CurrentSessionTransaction, obj: DeleteOperaLogParam) -> ResponseModel:
    count = await opera_log_service.delete(db=db, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.delete(
    '/all',
    summary='清空操作日志',
    dependencies=[
        Depends(RequestPermission('log:opera:clear')),
        DependsRBAC,
    ],
)
async def delete_all_opera_logs(db: CurrentSessionTransaction) -> ResponseModel:
    await opera_log_service.delete_all(db=db)
    return response_base.success()
