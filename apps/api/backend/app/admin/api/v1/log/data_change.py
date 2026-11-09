from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from backend.app.admin.schema.data_change import GetDataChangeDetail, GetDataChangeMeta
from backend.app.admin.service.data_change_service import data_change_service
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseSchemaModel, response_base
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
