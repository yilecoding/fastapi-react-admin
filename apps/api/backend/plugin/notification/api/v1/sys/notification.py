from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.notification.schema.notification import (
    GetNotificationDetail,
    GetNotificationUnreadDetail,
    SendNotificationParam,
)
from backend.plugin.notification.service.notification_service import notification_service

router = APIRouter()


# 🔴 下面这批「我的收件箱」接口刻意**只挂 `DependsJwtAuth`**，不挂权限码。
#
# 它们不是「读某张业务表」，是「读我自己的东西」——用户 ID 全部取自
# `request.user.id`，**不接受任何客户端传进来的 user_id**，所以越权面为零。
# 给它们编一个权限码反而有害：种子里漏挂到某个角色上，那个人就永远看不到
# 任何通知，而界面上只是「一条都没有」，跟真的没通知分不出来（硬纪律 9）。
# 对照 `apps/api/AGENTS.md` 里 #30 那条：那批要补权限码的是**通用读接口**
# （能读到别人的数据），和这里不是一类。


@router.get(
    '',
    summary='分页获取我的通知',
    dependencies=[
        DependsJwtAuth,
        DependsPagination,
    ],
)
async def get_my_notifications_paginated(
    request: Request,
    db: CurrentSession,
    title: Annotated[str | None, Query(description='标题')] = None,
    category: Annotated[int | None, Query(description='分类（0：系统、1：公告、2：任务事件）')] = None,
    unread: Annotated[bool | None, Query(description='只看未读 / 只看已读，不传则不筛')] = None,
) -> ResponseSchemaModel[PageData[GetNotificationDetail]]:
    page_data = await notification_service.get_list(
        db=db, user_id=request.user.id, title=title, category=category, unread=unread
    )
    return response_base.success(data=page_data)


@router.get('/unread-count', summary='获取我的未读数', dependencies=[DependsJwtAuth])
async def get_my_unread_count(request: Request, db: CurrentSession) -> ResponseSchemaModel[GetNotificationUnreadDetail]:
    data = await notification_service.get_unread(db=db, user_id=request.user.id)
    return response_base.success(data=data)


@router.put('/read-all', summary='标记我的全部通知已读', dependencies=[DependsJwtAuth])
async def mark_all_read(request: Request, db: CurrentSessionTransaction) -> ResponseModel:
    # ⚠️ 这条路由必须排在 `/{pk}/read` **前面**，否则 `read-all` 会先被
    # `/{pk}` 匹配走，pk 解析失败报 422（FastAPI 按声明顺序匹配）
    await notification_service.mark_all_read(db=db, user_id=request.user.id)
    return response_base.success()


@router.put('/{pk}/read', summary='标记通知已读', dependencies=[DependsJwtAuth])
async def mark_read(
    request: Request,
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='通知 ID')],
) -> ResponseModel:
    # 幂等：已经读过了返回 0 行，仍然是成功。
    # ⚠️ 不要拿返回的行数去判 `response_base.fail()` —— 重复点一条已读通知
    # 会被报成「操作失败」，而它本来就该什么都不做（AGENTS.md 里
    # 「update 返回的是写了几行，不是成败」同一个坑）
    await notification_service.mark_read(db=db, user_id=request.user.id, pk=pk)
    return response_base.success()


@router.post(
    '/send',
    summary='发送站内通知',
    dependencies=[
        Depends(RequestPermission('sys:notification:send')),
        DependsRBAC,
    ],
)
async def send_notification(db: CurrentSessionTransaction, obj: SendNotificationParam) -> ResponseModel:
    await notification_service.send(db=db, obj=obj)
    return response_base.success()
