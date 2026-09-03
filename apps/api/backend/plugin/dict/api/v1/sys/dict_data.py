from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.schema import SnowflakeIdIn
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.dict.schema.dict_data import (
    CreateDictDataParam,
    DeleteDictDataParam,
    GetDictDataDetail,
    UpdateDictDataParam,
)
from backend.plugin.dict.service.dict_data_service import dict_data_service

router = APIRouter()


@router.get(
    '/all',
    summary='获取所有字典数据',
    dependencies=[
        Depends(RequestPermission('dict:data:list')),
        DependsRBAC,
    ],
)
async def get_all_dict_datas(db: CurrentSession) -> ResponseSchemaModel[list[GetDictDataDetail]]:
    data = await dict_data_service.get_all(db=db)
    return response_base.success(data=data)


@router.get(
    '/{pk}',
    summary='获取字典数据详情',
    dependencies=[
        Depends(RequestPermission('dict:data:list')),
        DependsRBAC,
    ],
)
async def get_dict_data(
    db: CurrentSession,
    pk: Annotated[int, Path(description='字典数据 ID')],
) -> ResponseSchemaModel[GetDictDataDetail]:
    data = await dict_data_service.get(db=db, pk=pk)
    return response_base.success(data=data)


@router.get(
    '/type-codes/{code}',
    summary='获取字典数据列表',
    dependencies=[
        Depends(RequestPermission('dict:data:list')),
        DependsRBAC,
    ],
)
async def get_dict_data_by_type_code(
    db: CurrentSession,
    code: Annotated[str, Path(description='字典类型编码')],
) -> ResponseSchemaModel[list[GetDictDataDetail]]:
    data = await dict_data_service.get_by_type_code(db=db, code=code)
    return response_base.success(data=data)


@router.get(
    '',
    summary='分页获取所有字典数据',
    dependencies=[
        Depends(RequestPermission('dict:data:list')),
        DependsRBAC,
        DependsPagination,
    ],
)
async def get_dict_datas_paginated(
    db: CurrentSession,
    type_code: Annotated[str | None, Query(description='字典类型编码')] = None,
    label: Annotated[str | None, Query(description='字典数据标签')] = None,
    value: Annotated[str | None, Query(description='字典数据键值')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
    # 全仓唯一一个作为**查询参数**的雪花 ID。走 `SnowflakeIdIn` 让 OpenAPI 声明成
    # `string | integer` —— 前端手上的 ID 都是字符串（硬纪律 6）。
    # 请求体那一侧由各 schema 里的同一个标注负责，见 `common/schema.py`。
    type_id: Annotated[SnowflakeIdIn | None, Query(description='字典类型 ID')] = None,
) -> ResponseSchemaModel[PageData[GetDictDataDetail]]:
    page_data = await dict_data_service.get_list(
        db=db,
        type_code=type_code,
        label=label,
        value=value,
        status=status,
        type_id=type_id,
    )
    return response_base.success(data=page_data)


@router.post(
    '',
    summary='创建字典数据',
    dependencies=[
        Depends(RequestPermission('dict:data:add')),
        DependsRBAC,
    ],
)
async def create_dict_data(db: CurrentSessionTransaction, obj: CreateDictDataParam) -> ResponseModel:
    await dict_data_service.create(db=db, obj=obj)
    return response_base.success()


@router.put(
    '/{pk}',
    summary='更新字典数据',
    dependencies=[
        Depends(RequestPermission('dict:data:edit')),
        DependsRBAC,
    ],
)
async def update_dict_data(
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='字典数据 ID')],
    obj: UpdateDictDataParam,
) -> ResponseModel:
    count = await dict_data_service.update(db=db, pk=pk, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.delete(
    '',
    summary='批量删除字典数据',
    dependencies=[
        Depends(RequestPermission('dict:data:del')),
        DependsRBAC,
    ],
)
async def delete_dict_datas(db: CurrentSessionTransaction, obj: DeleteDictDataParam) -> ResponseModel:
    count = await dict_data_service.delete(db=db, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()
