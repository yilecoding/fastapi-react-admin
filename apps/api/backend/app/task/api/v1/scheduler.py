from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from backend.app.task.schema.scheduler import (
    CreateTaskSchedulerParam,
    DeleteTaskSchedulerParam,
    GetTaskSchedulerDetail,
    TaskSchedulerMeta,
    UpdateTaskSchedulerParam,
)
from backend.app.task.service import task_scheduler_service
from backend.common.pagination import DependsPagination, PageData, paging_data
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.get('/meta', summary='获取调度运行时元信息', dependencies=[DependsJwtAuth])
async def get_scheduler_meta() -> ResponseSchemaModel[TaskSchedulerMeta]:
    """给调度表单用：能选哪些任务 + beat 按哪个时区解释 crontab。

    - **tasks**：任务名手敲一个错字就是「调度按时触发、worker 收到不认识的
      名字」—— celery 只记一条 Received unregistered task，而界面上触发次数照涨。
      所以下拉里只给注册过的
    - **timezone**：前端算「近五次执行时间」预览要用它。用浏览器时区去算，
      在运维和服务器不同区时会得到一个看着对、实际差几小时的预览
    """
    return response_base.success(data=task_scheduler_service.get_meta())


@router.get('/all', summary='获取所有任务调度', dependencies=[DependsJwtAuth])
async def get_all_task_schedulers(db: CurrentSession) -> ResponseSchemaModel[list[GetTaskSchedulerDetail]]:
    return response_base.success(data=await task_scheduler_service.get_all(db=db))


@router.get('', summary='分页获取任务调度', dependencies=[DependsJwtAuth, DependsPagination])
async def get_task_schedulers_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='任务名称')] = None,
    task: Annotated[str | None, Query(description='Celery 任务')] = None,
    enabled: Annotated[bool | None, Query(description='是否启用')] = None,
) -> ResponseSchemaModel[PageData[GetTaskSchedulerDetail]]:
    stmt = await task_scheduler_service.get_select(name=name, task=task, enabled=enabled)
    return response_base.success(data=await paging_data(db, stmt))


@router.get('/{pk}', summary='获取任务调度详情', dependencies=[DependsJwtAuth])
async def get_task_scheduler(
    db: CurrentSession, pk: Annotated[int, Path(description='任务调度 ID')]
) -> ResponseSchemaModel[GetTaskSchedulerDetail]:
    return response_base.success(data=await task_scheduler_service.get(db=db, pk=pk))


@router.post(
    '',
    summary='创建任务调度',
    dependencies=[Depends(RequestPermission('task:scheduler:add')), DependsRBAC],
)
async def create_task_scheduler(
    db: CurrentSessionTransaction, obj: CreateTaskSchedulerParam
) -> ResponseSchemaModel[GetTaskSchedulerDetail]:
    return response_base.success(data=await task_scheduler_service.create(db=db, obj=obj))


@router.put(
    '/{pk}',
    summary='更新任务调度',
    dependencies=[Depends(RequestPermission('task:scheduler:edit')), DependsRBAC],
)
async def update_task_scheduler(
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='任务调度 ID')],
    obj: UpdateTaskSchedulerParam,
) -> ResponseModel:
    await task_scheduler_service.update(db=db, pk=pk, obj=obj)
    return response_base.success()


@router.put(
    '/{pk}/status',
    summary='启用/停用任务调度',
    dependencies=[Depends(RequestPermission('task:scheduler:edit')), DependsRBAC],
)
async def update_task_scheduler_status(
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='任务调度 ID')],
    enabled: Annotated[bool, Query(description='是否启用')],
) -> ResponseModel:
    # ⚠️ 不复用 PUT /{pk}：那个收整个对象，为了停用一条调度要把 crontab、
    # 参数、起止时间全带上回传，读漏一个字段就清掉一个
    await task_scheduler_service.set_enabled(db=db, pk=pk, enabled=enabled)
    return response_base.success()


@router.post(
    '/{pk}/run',
    summary='立即执行一次',
    dependencies=[Depends(RequestPermission('task:scheduler:run')), DependsRBAC],
)
async def run_task_scheduler_now(
    db: CurrentSession, pk: Annotated[int, Path(description='任务调度 ID')]
) -> ResponseSchemaModel[str]:
    """返回 celery 的 task_id，前端拿它到执行记录里查这一次的结果。"""
    return response_base.success(data=await task_scheduler_service.run_now(db=db, pk=pk))


@router.delete(
    '',
    summary='批量删除任务调度',
    dependencies=[Depends(RequestPermission('task:scheduler:del')), DependsRBAC],
)
async def delete_task_schedulers(db: CurrentSessionTransaction, obj: DeleteTaskSchedulerParam) -> ResponseModel:
    await task_scheduler_service.delete(db=db, obj=obj)
    return response_base.success()
