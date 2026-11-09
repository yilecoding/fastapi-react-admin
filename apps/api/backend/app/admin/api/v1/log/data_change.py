from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from backend.app.admin.dataio import DATA_CHANGE_EXPORT
from backend.app.admin.schema.data_change import GetDataChangeDetail, GetDataChangeIntegrity, GetDataChangeMeta
from backend.app.admin.schema.export_job import GetExportJobDetail, StartExportParam
from backend.app.admin.service.data_change_service import data_change_service
from backend.app.admin.service.export_service import export_service
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsSuperUser
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession

router = APIRouter()


@router.get(
    '/meta',
    summary='数据变更记录的筛选项',
    dependencies=[Depends(RequestPermission('log:change:list')), DependsRBAC],
)
async def get_data_change_meta() -> ResponseSchemaModel[GetDataChangeMeta]:
    return response_base.success(data=data_change_service.meta())


@router.get(
    '/integrity',
    summary='校验数据变更记录有没有被改过、删过（防篡改链）',
    # 超管才能点：整张表从头重算一遍，记录多的时候要几秒；结果里也会说密钥配没配
    dependencies=[DependsSuperUser],
)
async def verify_data_changes(db: CurrentSession) -> ResponseSchemaModel[GetDataChangeIntegrity]:
    return response_base.success(data=await data_change_service.verify(db))


@router.post(
    '/export',
    summary='导出数据变更记录',
    dependencies=[Depends(RequestPermission('log:change:export')), DependsRBAC],
)
async def export_data_changes(
    request: Request, db: CurrentSession, obj: StartExportParam
) -> ResponseSchemaModel[GetExportJobDetail]:
    # 小批量当场生成完才返回（status=2，前端直接下载）；大批量返回排队（status=0），生成完发站内消息
    data = await export_service.start(db=db, request=request, spec=DATA_CHANGE_EXPORT, obj=obj)
    return response_base.success(data=data)


@router.get(
    '',
    summary='分页获取数据变更记录',
    dependencies=[Depends(RequestPermission('log:change:list')), DependsRBAC, DependsPagination],
)
async def get_data_changes_paginated(
    db: CurrentSession,
    entity_type: Annotated[str | None, Query(description='对象类型')] = None,
    entity_id: Annotated[int | None, Query(description='对象 ID')] = None,
    actor: Annotated[str | None, Query(description='操作人用户名（模糊）')] = None,
    source: Annotated[str | None, Query(description='来源')] = None,
    action: Annotated[str | None, Query(description='动作')] = None,
    field: Annotated[str | None, Query(description='改过的字段')] = None,
    trace_id: Annotated[str | None, Query(description='请求跟踪 ID')] = None,
    start_time: Annotated[datetime | None, Query(description='时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='时间止')] = None,
) -> ResponseSchemaModel[PageData[GetDataChangeDetail]]:
    page_data = await data_change_service.get_list(
        db=db,
        entity_type=entity_type,
        entity_id=entity_id,
        actor=actor,
        source=source,
        action=action,
        field=field,
        trace_id=trace_id,
        start_time=start_time,
        end_time=end_time,
    )
    return response_base.success(data=page_data)
