from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.ai.schema.mcp_client import (
    CreateAiMcpClientParam,
    GetAiMcpClientDetail,
    IssuedAiMcpToken,
    UpdateAiMcpClientParam,
)
from backend.plugin.ai.service.mcp_client_service import ai_mcp_client_service

router = APIRouter()


@router.get(
    '',
    summary='分页获取 MCP 凭据',
    dependencies=[Depends(RequestPermission('ai:mcp:list')), DependsRBAC, DependsPagination],
)
async def get_mcp_clients_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='外部系统名称')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[PageData[GetAiMcpClientDetail]]:
    page_data = await ai_mcp_client_service.get_list(db=db, name=name, status=status)
    return response_base.success(data=page_data)


@router.get(
    '/{pk}',
    summary='获取 MCP 凭据详情',
    dependencies=[Depends(RequestPermission('ai:mcp:list')), DependsRBAC],
)
async def get_mcp_client(
    db: CurrentSession, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseSchemaModel[GetAiMcpClientDetail]:
    data = await ai_mcp_client_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.post(
    '',
    summary='新建 MCP 凭据（明文令牌只在这次响应里出现）',
    dependencies=[Depends(RequestPermission('ai:mcp:add')), DependsRBAC],
)
async def create_mcp_client(
    request: Request, db: CurrentSessionTransaction, obj: CreateAiMcpClientParam
) -> ResponseSchemaModel[IssuedAiMcpToken]:
    data = await ai_mcp_client_service.create(db=db, obj=obj, user_id=request.user.id)
    return response_base.success(data=data)


@router.put(
    '/{pk}',
    summary='更新 MCP 凭据',
    dependencies=[Depends(RequestPermission('ai:mcp:edit')), DependsRBAC],
)
async def update_mcp_client(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='记录 ID')], obj: UpdateAiMcpClientParam
) -> ResponseModel:
    await ai_mcp_client_service.update(db=db, pk=pk, obj=obj)
    return response_base.success()


@router.post(
    '/{pk}/rotate',
    summary='重新生成 MCP 令牌（旧令牌立即失效）',
    dependencies=[Depends(RequestPermission('ai:mcp:edit')), DependsRBAC],
)
async def rotate_mcp_client_token(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseSchemaModel[IssuedAiMcpToken]:
    data = await ai_mcp_client_service.rotate(db=db, pk=pk)
    return response_base.success(data=data)


@router.delete(
    '/{pk}',
    summary='删除 MCP 凭据',
    dependencies=[Depends(RequestPermission('ai:mcp:del')), DependsRBAC],
)
async def delete_mcp_client(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='记录 ID')]
) -> ResponseModel:
    count = await ai_mcp_client_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()
