from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from backend.app.task.schema.scheduler import DeleteTaskResultParam, GetTaskResultDetail
from backend.app.task.service import task_result_service
from backend.common.pagination import DependsPagination, PageData, paging_data
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.get('', summary='分页获取任务执行记录', dependencies=[DependsJwtAuth, DependsPagination])
async def get_task_results_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='任务名')] = None,
    task_id: Annotated[str | None, Query(description='任务 UUID')] = None,
    status: Annotated[str | None, Query(description='状态（SUCCESS/FAILURE/…）')] = None,
) -> ResponseSchemaModel[PageData[GetTaskResultDetail]]:
    stmt = await task_result_service.get_select(name=name, task_id=task_id, status=status)
    return response_base.success(data=await paging_data(db, stmt))


@router.get('/{pk}', summary='获取任务执行记录详情', dependencies=[DependsJwtAuth])
async def get_task_result(
    db: CurrentSession, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseSchemaModel[GetTaskResultDetail]:
    """详情比列表多的那两列（result / traceback）是长文本，界面上走详情抽屉。"""
    return response_base.success(data=await task_result_service.get(db=db, pk=pk))


@router.delete(
    '',
    summary='批量删除任务执行记录',
    dependencies=[Depends(RequestPermission('task:result:del')), DependsRBAC],
)
async def delete_task_results(db: CurrentSessionTransaction, obj: DeleteTaskResultParam) -> ResponseModel:
    await task_result_service.delete(db=db, obj=obj)
    return response_base.success()
