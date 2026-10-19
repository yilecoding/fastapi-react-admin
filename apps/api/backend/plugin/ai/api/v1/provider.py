from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.ai.schema.provider import (
    CreateAiProviderParam,
    GetAiProviderDetail,
    TestAiProviderResult,
    UpdateAiProviderParam,
)
from backend.plugin.ai.service.provider_service import ai_provider_service

router = APIRouter()


@router.get(
    '',
    summary='分页获取模型供应商',
    dependencies=[Depends(RequestPermission('ai:provider:list')), DependsRBAC, DependsPagination],
)
async def get_providers_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='供应商名称')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[PageData[GetAiProviderDetail]]:
    page_data = await ai_provider_service.get_list(db=db, name=name, status=status)
    return response_base.success(data=page_data)


@router.get(
    '/{pk}',
    summary='获取模型供应商详情',
    dependencies=[Depends(RequestPermission('ai:provider:list')), DependsRBAC],
)
async def get_provider(
    db: CurrentSession, pk: Annotated[int, Path(description='供应商 ID')]
) -> ResponseSchemaModel[GetAiProviderDetail]:
    data = await ai_provider_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.post(
    '',
    summary='创建模型供应商',
    dependencies=[Depends(RequestPermission('ai:provider:add')), DependsRBAC],
)
async def create_provider(request: Request, db: CurrentSessionTransaction, obj: CreateAiProviderParam) -> ResponseModel:
    await ai_provider_service.create(db=db, obj=obj, user_id=request.user.id)
    return response_base.success()


@router.put(
    '/{pk}',
    summary='更新模型供应商',
    dependencies=[Depends(RequestPermission('ai:provider:edit')), DependsRBAC],
)
async def update_provider(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='供应商 ID')], obj: UpdateAiProviderParam
) -> ResponseModel:
    await ai_provider_service.update(db=db, pk=pk, obj=obj)
    return response_base.success()


@router.delete(
    '/{pk}',
    summary='删除模型供应商',
    dependencies=[Depends(RequestPermission('ai:provider:del')), DependsRBAC],
)
async def delete_provider(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='供应商 ID')]
) -> ResponseModel:
    count = await ai_provider_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.post(
    '/{pk}/test',
    summary='测试模型供应商连通性',
    # 用 edit 而不是 list：这条会**真的往外发请求**（消耗配额、暴露内网地址），
    # 不该让只有只读权限的人能触发
    dependencies=[Depends(RequestPermission('ai:provider:edit')), DependsRBAC],
)
async def test_provider(
    db: CurrentSession, pk: Annotated[int, Path(description='供应商 ID')]
) -> ResponseSchemaModel[TestAiProviderResult]:
    data = await ai_provider_service.test(db=db, pk=pk)
    return response_base.success(data=data)
