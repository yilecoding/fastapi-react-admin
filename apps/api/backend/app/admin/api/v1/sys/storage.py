from typing import Annotated

from fastapi import APIRouter, Body, Depends, Path

from backend.app.admin.schema.storage import (
    CreateStorageParam,
    GetStorageDetail,
    TestStorageResult,
    UpdateStorageParam,
    UpdateStorageStatusParam,
)
from backend.app.admin.service.storage_service import storage_service
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.schema import SnowflakeIdIn
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.get(
    '',
    summary='获取全部存储（第一行是内置本地存储）',
    dependencies=[Depends(RequestPermission('sys:storage:list')), DependsRBAC],
)
async def get_storages(db: CurrentSession) -> ResponseSchemaModel[list[GetStorageDetail]]:
    data = await storage_service.get_list(db=db)
    return response_base.success(data=data)


@router.post(
    '',
    summary='创建存储',
    dependencies=[Depends(RequestPermission('sys:storage:add')), DependsRBAC],
)
async def create_storage(db: CurrentSessionTransaction, obj: CreateStorageParam) -> ResponseModel:
    await storage_service.create(db=db, obj=obj)
    return response_base.success()


# ⚠️ 声明在 `/{pk}` 之前：一段的固定路径放在后面会被 `{pk}` 吞掉，表现是 422「pk 不是合法整数」
@router.put(
    '/default',
    summary='设置默认存储（null = 内置本地存储）',
    dependencies=[Depends(RequestPermission('sys:storage:edit')), DependsRBAC],
)
async def set_default_storage(
    db: CurrentSessionTransaction,
    storage_id: Annotated[SnowflakeIdIn | None, Body(embed=True, description='存储 ID，null 表示内置本地存储')] = None,
) -> ResponseModel:
    await storage_service.set_default(db=db, pk=storage_id)
    return response_base.success()


@router.put(
    '/{pk}',
    summary='更新存储',
    dependencies=[Depends(RequestPermission('sys:storage:edit')), DependsRBAC],
)
async def update_storage(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='存储 ID')], obj: UpdateStorageParam
) -> ResponseModel:
    await storage_service.update(db=db, pk=pk, obj=obj)
    # 不拿 rowcount 判成败：MySQL 数的是「改了的」行，原样保存一次就是 0（根 CLAUDE.md 那张表）；
    # 记录不存在的情形 service 已经 404 了
    return response_base.success()


@router.put(
    '/{pk}/status',
    summary='启用 / 停用存储',
    dependencies=[Depends(RequestPermission('sys:storage:edit')), DependsRBAC],
)
async def update_storage_status(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='存储 ID')], obj: UpdateStorageStatusParam
) -> ResponseModel:
    await storage_service.set_status(db=db, pk=pk, status=obj.status)
    # 设成同一个值在 MySQL 上是 0 行（rowcount 数「改了的」行），别拿 count 判成败（根 CLAUDE.md 那张表）
    return response_base.success()


@router.post(
    '/{pk}/test',
    summary='测试连接（写入 → 读回 → 删除一个探测对象）',
    dependencies=[Depends(RequestPermission('sys:storage:edit')), DependsRBAC],
)
async def test_storage(
    db: CurrentSession, pk: Annotated[int, Path(description='存储 ID')]
) -> ResponseSchemaModel[TestStorageResult]:
    # 连不通是**测试结果**，不是接口失败：ok=false 走 success()，前端按 ok 显示
    result = await storage_service.test(db=db, pk=pk)
    return response_base.success(data=result)


@router.delete(
    '/{pk}',
    summary='删除存储（存储下还有文件时拒绝）',
    dependencies=[Depends(RequestPermission('sys:storage:del')), DependsRBAC],
)
async def delete_storage(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='存储 ID')]
) -> ResponseModel:
    count = await storage_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()
