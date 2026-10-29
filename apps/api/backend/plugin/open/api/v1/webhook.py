from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession
from backend.plugin.open.schema.webhook import (
    CreateWebhookParam,
    GetWebhookDeliveryDetail,
    GetWebhookDeliveryRow,
    GetWebhookDetail,
    IssuedWebhookSecret,
    PingResult,
    ResendExhaustedParam,
    ResendResult,
    UpdateWebhookParam,
    WebhookEventItem,
)
from backend.plugin.open.service.webhook_service import webhook_service

# 🔴 写接口用 `CurrentSession` + 自己 commit、再踢 worker：踢必须在提交之后（`event_service` 头注释）。
# `CurrentSessionTransaction` 是在依赖收尾时才提交的，路由里拿不到那个时刻
router = APIRouter()
delivery_router = APIRouter()


@router.get(
    '/events',
    summary='获取可订阅的 Webhook 事件目录',
    dependencies=[Depends(RequestPermission('open:webhook:list')), DependsRBAC],
)
async def get_webhook_events() -> ResponseSchemaModel[list[WebhookEventItem]]:
    return response_base.success(data=webhook_service.events())


@router.get(
    '',
    summary='获取应用的 Webhook 端点',
    dependencies=[Depends(RequestPermission('open:webhook:list')), DependsRBAC],
)
async def get_webhooks(
    db: CurrentSession, app_id: Annotated[int, Query(description='应用 ID')]
) -> ResponseSchemaModel[list[GetWebhookDetail]]:
    data = await webhook_service.get_list(db=db, app_id=app_id)
    return response_base.success(data=data)


@router.get(
    '/{pk}',
    summary='获取 Webhook 端点详情',
    dependencies=[Depends(RequestPermission('open:webhook:list')), DependsRBAC],
)
async def get_webhook(
    db: CurrentSession, pk: Annotated[int, Path(description='端点 ID')]
) -> ResponseSchemaModel[GetWebhookDetail]:
    return response_base.success(data=await webhook_service.get(db=db, pk=pk))


@router.post(
    '',
    summary='新建 Webhook 端点（明文签名密钥只在这次响应里出现）',
    dependencies=[Depends(RequestPermission('open:webhook:add')), DependsRBAC],
)
async def create_webhook(
    request: Request, db: CurrentSession, obj: CreateWebhookParam
) -> ResponseSchemaModel[IssuedWebhookSecret]:
    data = await webhook_service.create(db=db, obj=obj, user_id=request.user.id)
    await db.commit()
    return response_base.success(data=data)


@router.put(
    '/{pk}',
    summary='更新 Webhook 端点',
    dependencies=[Depends(RequestPermission('open:webhook:edit')), DependsRBAC],
)
async def update_webhook(
    db: CurrentSession, pk: Annotated[int, Path(description='端点 ID')], obj: UpdateWebhookParam
) -> ResponseModel:
    await webhook_service.update(db=db, pk=pk, obj=obj)
    await db.commit()
    return response_base.success()


@router.post(
    '/{pk}/secret',
    summary='重置 Webhook 签名密钥（旧密钥再签 24 小时）',
    dependencies=[Depends(RequestPermission('open:webhook:reset')), DependsRBAC],
)
async def reset_webhook_secret(
    db: CurrentSession, pk: Annotated[int, Path(description='端点 ID')]
) -> ResponseSchemaModel[IssuedWebhookSecret]:
    data = await webhook_service.reset_secret(db=db, pk=pk)
    await db.commit()
    return response_base.success(data=data)


@router.delete(
    '/{pk}',
    summary='删除 Webhook 端点（连同它的投递记录）',
    dependencies=[Depends(RequestPermission('open:webhook:del')), DependsRBAC],
)
async def delete_webhook(db: CurrentSession, pk: Annotated[int, Path(description='端点 ID')]) -> ResponseModel:
    await webhook_service.delete(db=db, pk=pk)
    await db.commit()
    return response_base.success()


@router.post(
    '/{pk}/ping',
    summary='给端点发一个测试事件（当场发出、返回结果）',
    dependencies=[Depends(RequestPermission('open:webhook:test')), DependsRBAC],
)
async def ping_webhook(pk: Annotated[int, Path(description='端点 ID')]) -> ResponseSchemaModel[PingResult]:
    return response_base.success(data=await webhook_service.ping(pk=pk))


@router.post(
    '/{pk}/resend',
    summary='把端点在某时间之后放弃的投递全部改回待发',
    dependencies=[Depends(RequestPermission('open:webhook:resend')), DependsRBAC],
)
async def resend_exhausted(
    db: CurrentSession, pk: Annotated[int, Path(description='端点 ID')], obj: ResendExhaustedParam
) -> ResponseSchemaModel[ResendResult]:
    count = await webhook_service.resend_exhausted(db=db, pk=pk, since=obj.since)
    await db.commit()
    if count:
        await webhook_service.kick()
    return response_base.success(data=ResendResult(count=count))


@delivery_router.get(
    '',
    summary='分页获取 Webhook 投递记录',
    dependencies=[Depends(RequestPermission('open:webhook:list')), DependsRBAC, DependsPagination],
)
async def get_webhook_deliveries(
    db: CurrentSession,
    app_id: Annotated[int | None, Query(description='应用 ID')] = None,
    webhook_id: Annotated[int | None, Query(description='端点 ID')] = None,
    event_type: Annotated[str | None, Query(description='事件类型')] = None,
    status: Annotated[str | None, Query(description='状态')] = None,
) -> ResponseSchemaModel[PageData[GetWebhookDeliveryRow]]:
    data = await webhook_service.deliveries(
        db=db, app_id=app_id, webhook_id=webhook_id, event_type=event_type, status=status
    )
    return response_base.success(data=data)


@delivery_router.get(
    '/{pk}',
    summary='获取 Webhook 投递详情（含每一次尝试）',
    dependencies=[Depends(RequestPermission('open:webhook:list')), DependsRBAC],
)
async def get_webhook_delivery(
    db: CurrentSession, pk: Annotated[int, Path(description='投递 ID')]
) -> ResponseSchemaModel[GetWebhookDeliveryDetail]:
    return response_base.success(data=await webhook_service.delivery(db=db, pk=pk))


@delivery_router.post(
    '/{pk}/resend',
    summary='重发一条 Webhook 投递',
    dependencies=[Depends(RequestPermission('open:webhook:resend')), DependsRBAC],
)
async def resend_webhook_delivery(db: CurrentSession, pk: Annotated[int, Path(description='投递 ID')]) -> ResponseModel:
    await webhook_service.resend(db=db, pk=pk)
    await db.commit()
    await webhook_service.kick()
    return response_base.success()
