from typing import Annotated, Any

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.open.schema.app import (
    CreateOpenAppParam,
    GetOpenAppDetail,
    IssuedOpenSecret,
    OpenScopeItem,
    UpdateOpenAppParam,
)
from backend.plugin.open.service.app_service import open_app_service

router = APIRouter()


@router.get(
    '',
    summary='分页获取能力开放应用',
    dependencies=[Depends(RequestPermission('open:app:list')), DependsRBAC, DependsPagination],
)
async def get_open_apps_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='应用名称或编码')] = None,
    status: Annotated[int | None, Query(description='状态（0：停用、1：正常、2：已过期）')] = None,
) -> ResponseSchemaModel[PageData[GetOpenAppDetail]]:
    page_data = await open_app_service.get_list(db=db, name=name, status=status)
    return response_base.success(data=page_data)


# ⚠️ 两条固定路径要排在 `/{pk}` 前面，否则会被当成 pk 解析成 422
@router.get(
    '/scopes',
    summary='获取可授权的开放接口清单',
    dependencies=[Depends(RequestPermission('open:app:list')), DependsRBAC],
)
async def get_open_scopes(request: Request) -> ResponseSchemaModel[list[OpenScopeItem]]:
    return response_base.success(data=open_app_service.get_scopes(request.app))


@router.get(
    '/openapi.json',
    summary='导出开放接口的 OpenAPI 文档',
    dependencies=[Depends(RequestPermission('open:app:list')), DependsRBAC],
)
async def get_open_openapi(request: Request) -> dict[str, Any]:
    return open_app_service.openapi(request.app)


@router.get(
    '/{pk}',
    summary='获取能力开放应用详情',
    dependencies=[Depends(RequestPermission('open:app:list')), DependsRBAC],
)
async def get_open_app(
    db: CurrentSession, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseSchemaModel[GetOpenAppDetail]:
    data = await open_app_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.post(
    '',
    summary='新建能力开放应用（明文 SK 只在这次响应里出现）',
    dependencies=[Depends(RequestPermission('open:app:add')), DependsRBAC],
)
async def create_open_app(
    request: Request, db: CurrentSessionTransaction, obj: CreateOpenAppParam
) -> ResponseSchemaModel[IssuedOpenSecret]:
    data = await open_app_service.create(db=db, obj=obj, user_id=request.user.id)
    return response_base.success(data=data)


@router.put(
    '/{pk}',
    summary='更新能力开放应用',
    dependencies=[Depends(RequestPermission('open:app:edit')), DependsRBAC],
)
async def update_open_app(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='记录 ID')], obj: UpdateOpenAppParam
) -> ResponseModel:
    await open_app_service.update(db=db, pk=pk, obj=obj)
    return response_base.success()


@router.post(
    '/{pk}/secret',
    summary='重置能力开放应用的密钥（旧 SK 立即失效）',
    dependencies=[Depends(RequestPermission('open:app:reset')), DependsRBAC],
)
async def reset_open_app_secret(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseSchemaModel[IssuedOpenSecret]:
    data = await open_app_service.reset_secret(db=db, pk=pk)
    return response_base.success(data=data)


@router.delete(
    '/{pk}',
    summary='删除能力开放应用',
    dependencies=[Depends(RequestPermission('open:app:del')), DependsRBAC],
)
async def delete_open_app(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseModel:
    count = await open_app_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()
