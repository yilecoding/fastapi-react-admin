from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.sms.schema.log import DeleteSmsLogParam, GetSmsLogDetail, GetSmsLogListItem
from backend.plugin.sms.service.log_service import sms_log_service

router = APIRouter()


@router.get(
    '',
    summary='分页获取短信发送日志（手机号掩码）',
    dependencies=[Depends(RequestPermission('sms:log:list')), DependsRBAC, DependsPagination],
)
async def get_sms_logs_paginated(
    db: CurrentSession,
    phone: Annotated[str | None, Query(description='手机号（全等）')] = None,
    config_id: Annotated[int | None, Query(description='配置 ID')] = None,
    template: Annotated[str | None, Query(description='业务模板码')] = None,
    status: Annotated[int | None, Query(description='状态（0 失败 · 1 已受理 · 2 结果未知 · 3 发送中）')] = None,
    error_kind: Annotated[str | None, Query(description='错误类型')] = None,
    start_time: Annotated[datetime | None, Query(description='创建时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='创建时间止')] = None,
) -> ResponseSchemaModel[PageData[GetSmsLogListItem]]:
    page_data = await sms_log_service.get_list(
        db=db,
        phone=phone,
        config_id=config_id,
        template=template,
        status=status,
        error_kind=error_kind,
        start_time=start_time,
        end_time=end_time,
    )
    return response_base.success(data=page_data)


@router.get(
    '/{pk}',
    summary='获取短信发送日志详情（完整手机号）',
    dependencies=[Depends(RequestPermission('sms:log:list')), DependsRBAC],
)
async def get_sms_log(
    db: CurrentSession, pk: Annotated[int, Path(description='日志 ID')]
) -> ResponseSchemaModel[GetSmsLogDetail]:
    data = await sms_log_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.delete(
    '',
    summary='批量删除短信发送日志',
    dependencies=[Depends(RequestPermission('sms:log:del')), DependsRBAC],
)
async def delete_sms_logs(db: CurrentSessionTransaction, obj: DeleteSmsLogParam) -> ResponseModel:
    count = await sms_log_service.delete(db=db, pks=obj.pks)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.delete(
    '/all',
    summary='清空短信发送日志',
    dependencies=[Depends(RequestPermission('sms:log:del')), DependsRBAC],
)
async def delete_all_sms_logs(db: CurrentSessionTransaction) -> ResponseModel:
    await sms_log_service.delete_all(db=db)
    return response_base.success()
