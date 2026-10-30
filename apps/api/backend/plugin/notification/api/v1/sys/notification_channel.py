"""通知渠道路由的接口（#166）：系统策略矩阵 · 我的偏好矩阵 · 投递记录 / 重发 · 群机器人（二期）"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.notification.enums import DeliveryStatus, NotificationChannel
from backend.plugin.notification.schema.bot import (
    BotOptions,
    BotTestResult,
    CreateBotParam,
    GetBotDetail,
    UpdateBotParam,
)
from backend.plugin.notification.schema.channel import (
    GetDeliveryDetail,
    GetMyPrefsDetail,
    PolicyRow,
    UpdatePoliciesParam,
    UpdatePrefsParam,
)
from backend.plugin.notification.service.bot_service import bot_service
from backend.plugin.notification.service.channel_service import channel_service
from backend.plugin.notification.service.delivery_service import delivery_service, kick

router = APIRouter()


# 🔴「我的偏好」两条只挂 `DependsJwtAuth`，理由同收件箱（`notification.py` 顶上那段）：
# 用户 ID 全部取自 `request.user.id`，不接受客户端传 user_id；给它编权限码，种子漏挂到某个角色上，
# 那个人就永远改不了自己的通知偏好，而界面上只是「加载失败」。


@router.get('/prefs/me', summary='获取我的通知偏好', dependencies=[DependsJwtAuth])
async def get_my_prefs(request: Request, db: CurrentSession) -> ResponseSchemaModel[GetMyPrefsDetail]:
    data = await channel_service.get_my_prefs(db, request.user.id)
    return response_base.success(data=data)


@router.put('/prefs/me', summary='更新我的通知偏好', dependencies=[DependsJwtAuth])
async def update_my_prefs(request: Request, db: CurrentSessionTransaction, obj: UpdatePrefsParam) -> ResponseModel:
    await channel_service.update_my_prefs(db, obj, request.user.id)
    return response_base.success()


@router.get(
    '/policies',
    summary='获取通知渠道系统策略',
    dependencies=[Depends(RequestPermission('sys:notification:policy:list')), DependsRBAC],
)
async def get_policies(db: CurrentSession) -> ResponseSchemaModel[list[PolicyRow]]:
    data = await channel_service.get_policies(db)
    return response_base.success(data=data)


@router.put(
    '/policies',
    summary='更新通知渠道系统策略',
    dependencies=[Depends(RequestPermission('sys:notification:policy:edit')), DependsRBAC],
)
async def update_policies(request: Request, db: CurrentSessionTransaction, obj: UpdatePoliciesParam) -> ResponseModel:
    await channel_service.update_policies(db, obj, request.user.id)
    return response_base.success()


@router.get(
    '/deliveries',
    summary='分页获取通知投递记录（地址掩码）',
    dependencies=[Depends(RequestPermission('sys:notification:delivery:list')), DependsRBAC, DependsPagination],
)
async def get_deliveries_paginated(
    db: CurrentSession,
    kind: Annotated[str | None, Query(description='通知类型码')] = None,
    channel: Annotated[NotificationChannel | None, Query(description='渠道')] = None,
    status: Annotated[DeliveryStatus | None, Query(description='状态')] = None,
    user_id: Annotated[int | None, Query(description='接收人 ID')] = None,
    bot_id: Annotated[int | None, Query(description='群机器人 ID')] = None,
    start_time: Annotated[datetime | None, Query(description='创建时间起')] = None,
    end_time: Annotated[datetime | None, Query(description='创建时间止')] = None,
) -> ResponseSchemaModel[PageData[GetDeliveryDetail]]:
    data = await delivery_service.get_list(
        db,
        kind=kind,
        channel=channel.value if channel else None,
        status=status.value if status else None,
        user_id=user_id,
        bot_id=bot_id,
        start_time=start_time,
        end_time=end_time,
    )
    return response_base.success(data=data)


@router.get(
    '/deliveries/{pk}',
    summary='获取通知投递记录详情（完整地址）',
    dependencies=[Depends(RequestPermission('sys:notification:delivery:list')), DependsRBAC],
)
async def get_delivery(
    db: CurrentSession, pk: Annotated[int, Path(description='投递记录 ID')]
) -> ResponseSchemaModel[GetDeliveryDetail]:
    data = await delivery_service.get(db, pk)
    return response_base.success(data=data)


@router.post(
    '/deliveries/{pk}/resend',
    summary='重发一条通知投递',
    dependencies=[Depends(RequestPermission('sys:notification:delivery:resend')), DependsRBAC],
)
async def resend_delivery(db: CurrentSession, pk: Annotated[int, Path(description='投递记录 ID')]) -> ResponseModel:
    # 自己管事务：要在**提交之后**踢 worker —— 用 CurrentSessionTransaction 的话提交在依赖收尾，
    # 踢早了 worker 读到的还是旧状态
    if db.in_transaction():
        # 依赖注入里可能已经隐式开了一个只读事务（autobegin），先收掉（同审批流 `_run`）
        await db.rollback()
    async with db.begin():
        await delivery_service.resend(db, pk)
    await kick()
    return response_base.success()


# ── 群机器人（#166 二期）────────────────────────────────────────────────────


@router.get(
    '/bots/options',
    summary='获取群机器人表单选项（能订阅的通知类型）',
    dependencies=[Depends(RequestPermission('sys:notification:bot:list')), DependsRBAC],
)
async def get_bot_options() -> ResponseSchemaModel[BotOptions]:
    return response_base.success(data=bot_service.options())


@router.get(
    '/bots',
    summary='获取全部群机器人（地址掩码）',
    dependencies=[Depends(RequestPermission('sys:notification:bot:list')), DependsRBAC],
)
async def get_bots(db: CurrentSession) -> ResponseSchemaModel[list[GetBotDetail]]:
    return response_base.success(data=await bot_service.get_list(db))


@router.post(
    '/bots',
    summary='新增群机器人',
    dependencies=[Depends(RequestPermission('sys:notification:bot:add')), DependsRBAC],
)
async def create_bot(
    request: Request, db: CurrentSessionTransaction, obj: CreateBotParam
) -> ResponseSchemaModel[GetBotDetail]:
    return response_base.success(data=await bot_service.create(db, obj, request.user.id))


@router.put(
    '/bots/{pk}',
    summary='更新群机器人',
    dependencies=[Depends(RequestPermission('sys:notification:bot:edit')), DependsRBAC],
)
async def update_bot(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='群机器人 ID')], obj: UpdateBotParam
) -> ResponseSchemaModel[GetBotDetail]:
    return response_base.success(data=await bot_service.update(db, pk, obj))


@router.delete(
    '/bots/{pk}',
    summary='删除群机器人',
    dependencies=[Depends(RequestPermission('sys:notification:bot:del')), DependsRBAC],
)
async def delete_bot(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='群机器人 ID')]
) -> ResponseModel:
    await bot_service.delete(db, pk)
    return response_base.success()


@router.post(
    '/bots/{pk}/test',
    summary='给群机器人发一条测试消息',
    dependencies=[Depends(RequestPermission('sys:notification:bot:test')), DependsRBAC],
)
async def test_bot(
    db: CurrentSessionTransaction, pk: Annotated[int, Path(description='群机器人 ID')]
) -> ResponseSchemaModel[BotTestResult]:
    # 发失败也是 200：结果本身就是这个接口要回答的东西（原因分类 + 对方原话），前端照着显示
    return response_base.success(data=await bot_service.send_test(db, pk))
