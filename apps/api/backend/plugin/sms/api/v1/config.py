from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request
from pyrate_limiter import Duration, Rate

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.sms.schema.config import (
    CreateSmsConfigParam,
    GetSmsConfigDetail,
    SmsProviderDescriptor,
    SmsSendResultSchema,
    SmsTemplateDescriptor,
    TestSmsParam,
    UpdateSmsConfigParam,
)
from backend.plugin.sms.service.config_service import sms_config_service
from backend.utils.limiter import RateLimiter

router = APIRouter()


def _by_operator(request: Request) -> str:
    """测试短信的限流按**操作人**计（不按 IP）：一个办公室出口 IP 后面坐着所有管理员"""
    user = getattr(request, 'user', None)
    return f'sms-test:{getattr(user, "id", None) or "anonymous"}'


@router.get(
    '',
    summary='分页获取短信配置',
    dependencies=[Depends(RequestPermission('sms:config:list')), DependsRBAC, DependsPagination],
)
async def get_sms_configs_paginated(
    db: CurrentSession,
    name: Annotated[str | None, Query(description='配置名称（模糊）')] = None,
    provider: Annotated[str | None, Query(description='厂商码')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[PageData[GetSmsConfigDetail]]:
    page_data = await sms_config_service.get_list(db=db, name=name, provider=provider, status=status)
    return response_base.success(data=page_data)


# ⚠️ 固定路径声明在 `/{pk}` 之前：放后面会被 `{pk}` 吞掉，表现是 422「pk 不是合法整数」
@router.get(
    '/providers',
    summary='获取可用的短信厂商（SDK 注册表）',
    dependencies=[Depends(RequestPermission('sms:config:list')), DependsRBAC],
)
async def get_sms_providers() -> ResponseSchemaModel[list[SmsProviderDescriptor]]:
    return response_base.success(data=sms_config_service.providers())


@router.get(
    '/templates',
    summary='获取已注册的业务模板',
    dependencies=[Depends(RequestPermission('sms:config:list')), DependsRBAC],
)
async def get_sms_templates() -> ResponseSchemaModel[list[SmsTemplateDescriptor]]:
    return response_base.success(data=sms_config_service.templates())


@router.get(
    '/{pk}',
    summary='获取短信配置详情',
    dependencies=[Depends(RequestPermission('sms:config:list')), DependsRBAC],
)
async def get_sms_config(
    db: CurrentSession, pk: Annotated[int, Path(description='配置 ID')]
) -> ResponseSchemaModel[GetSmsConfigDetail]:
    data = await sms_config_service.get_detail(db=db, pk=pk)
    return response_base.success(data=data)


@router.post(
    '',
    summary='创建短信配置',
    dependencies=[Depends(RequestPermission('sms:config:add')), DependsRBAC],
)
async def create_sms_config(
    request: Request, db: CurrentSessionTransaction, obj: CreateSmsConfigParam
) -> ResponseModel:
    await sms_config_service.create(db=db, obj=obj, user_id=request.user.id)
    return response_base.success()


@router.put(
    '/{pk}',
    summary='更新短信配置',
    dependencies=[Depends(RequestPermission('sms:config:edit')), DependsRBAC],
)
async def update_sms_config(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='配置 ID')], obj: UpdateSmsConfigParam
) -> ResponseModel:
    await sms_config_service.update(db=db, pk=pk, obj=obj)
    # 不拿 rowcount 判成败：记录不存在的情形 service 已经 404 了
    return response_base.success()


@router.put(
    '/{pk}/default',
    summary='设为默认配置（同一时间只有一条）',
    dependencies=[Depends(RequestPermission('sms:config:edit')), DependsRBAC],
)
async def set_default_sms_config(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='配置 ID')]
) -> ResponseModel:
    await sms_config_service.set_default(db=db, pk=pk)
    return response_base.success()


@router.delete(
    '/{pk}',
    summary='删除短信配置',
    dependencies=[Depends(RequestPermission('sms:config:del')), DependsRBAC],
)
async def delete_sms_config(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='配置 ID')]
) -> ResponseModel:
    count = await sms_config_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.post(
    '/{pk}/test',
    summary='发测试短信（真发一条，绕过业务模板）',
    dependencies=[
        Depends(RequestPermission('sms:config:test')),
        DependsRBAC,
        # 按操作人 5 次 / 分钟。全站熔断的计数口径见 service/sms_service.py: send_test
        Depends(RateLimiter(Rate(5, Duration.MINUTE), identifier=_by_operator)),
    ],
)
async def test_sms_config(
    request: Request, db: CurrentSession, pk: Annotated[int, Path(description='配置 ID')], obj: TestSmsParam
) -> ResponseSchemaModel[SmsSendResultSchema]:
    # 连不通 / 被拒是**测试结果**，不是接口失败：status != accepted 也走 success()，前端按 status 显示
    data = await sms_config_service.test(db=db, pk=pk, obj=obj, user_id=request.user.id)
    return response_base.success(data=data)
