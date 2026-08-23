from typing import Annotated

from fastapi import APIRouter, Body, Depends, Path, Query, Request
from pydantic import HttpUrl

from backend.app.admin.schema.role import GetRoleDetail
from backend.app.admin.schema.user import (
    AddUserParam,
    GetCurrentUserInfoWithRelationDetail,
    GetUserInfoWithRelationDetail,
    ResetPasswordParam,
    UpdateUserParam,
)
from backend.app.admin.service.user_service import user_service
from backend.common.enums import UserPermissionType
from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.schema import IanaTimeZone
from backend.common.security.jwt import DependsJwtAuth, DependsSuperUser
from backend.common.security.permission import RequestPermission
from backend.common.security.rbac import DependsRBAC
from backend.database.db import CurrentSession, CurrentSessionTransaction

router = APIRouter()


@router.get('/me', summary='获取当前用户信息', dependencies=[DependsJwtAuth])
async def get_current_user(request: Request) -> ResponseSchemaModel[GetCurrentUserInfoWithRelationDetail]:
    data = request.user.model_dump()
    return response_base.success(data=data)


@router.get('/{pk}', summary='获取用户信息', dependencies=[DependsJwtAuth])
async def get_userinfo(
    db: CurrentSession,
    pk: Annotated[int, Path(description='用户 ID')],
) -> ResponseSchemaModel[GetUserInfoWithRelationDetail]:
    data = await user_service.get_userinfo(db=db, pk=pk)
    return response_base.success(data=data)


@router.get('/{pk}/roles', summary='获取用户所有角色', dependencies=[DependsJwtAuth])
async def get_user_roles(
    db: CurrentSession, pk: Annotated[int, Path(description='用户 ID')]
) -> ResponseSchemaModel[list[GetRoleDetail]]:
    data = await user_service.get_roles(db=db, pk=pk)
    return response_base.success(data=data)


@router.get(
    '',
    summary='分页获取所有用户',
    dependencies=[
        DependsJwtAuth,
        DependsPagination,
    ],
)
async def get_users_paginated(
    db: CurrentSession,
    dept: Annotated[int | None, Query(description='部门 ID')] = None,
    username: Annotated[str | None, Query(description='用户名')] = None,
    phone: Annotated[str | None, Query(description='手机号')] = None,
    status: Annotated[int | None, Query(description='状态')] = None,
    role: Annotated[int | None, Query(description='角色 ID')] = None,
) -> ResponseSchemaModel[PageData[GetUserInfoWithRelationDetail]]:
    page_data = await user_service.get_list(
        db=db, dept=dept, username=username, phone=phone, status=status, role=role
    )
    return response_base.success(data=page_data)


@router.post('', summary='创建用户', dependencies=[DependsSuperUser])
async def create_user(
    db: CurrentSessionTransaction, obj: AddUserParam
) -> ResponseSchemaModel[GetUserInfoWithRelationDetail]:
    await user_service.create(db=db, obj=obj)
    data = await user_service.get_userinfo(db=db, username=obj.username)
    return response_base.success(data=data)


@router.put('/{pk}', summary='更新用户信息', dependencies=[DependsSuperUser])
async def update_user(
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='用户 ID')],
    obj: UpdateUserParam,
) -> ResponseModel:
    count = await user_service.update(db=db, pk=pk, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/{pk}/permissions', summary='更新用户权限', dependencies=[DependsSuperUser])
async def update_user_permission(
    db: CurrentSessionTransaction,
    request: Request,
    pk: Annotated[int, Path(description='用户 ID')],
    type: Annotated[UserPermissionType, Query(description='权限类型')],
) -> ResponseModel:
    count = await user_service.update_permission(db=db, request=request, pk=pk, type=type)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/me/password', summary='更新当前用户密码', dependencies=[DependsJwtAuth])
async def update_user_password(
    db: CurrentSessionTransaction, request: Request, obj: ResetPasswordParam
) -> ResponseModel:
    count = await user_service.update_password(db=db, user_id=request.user.id, obj=obj)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/{pk}/password', summary='重置用户密码', dependencies=[DependsSuperUser])
async def reset_user_password(
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='用户 ID')],
    password: Annotated[str, Body(embed=True, description='新密码')],
) -> ResponseModel:
    count = await user_service.reset_password(db=db, pk=pk, password=password)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/me/nickname', summary='更新当前用户昵称', dependencies=[DependsJwtAuth])
async def update_user_nickname(
    db: CurrentSessionTransaction,
    request: Request,
    nickname: Annotated[str, Body(embed=True, description='用户昵称')],
) -> ResponseModel:
    count = await user_service.update_nickname(db=db, user_id=request.user.id, nickname=nickname)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/me/avatar', summary='更新当前用户头像', dependencies=[DependsJwtAuth])
async def update_user_avatar(
    db: CurrentSessionTransaction,
    request: Request,
    # 🔴 入参必须是 HttpUrl | None，**不能是裸 str**。
    # 读取侧（GetUserInfoDetail.avatar）是 `HttpUrl | None`，写入侧原来收裸 str ——
    # 于是前端把头像清成 '' 存进库之后，**登录和 /users/me 全部 422**
    # （`url_parsing: input is empty`），连改坏它的人自己也登不回来。实测确认过。
    # 与「参数配置」那条同一个形状：写入宽松 + 读取严格 = 一个空值锁死全站。
    # None 表示「清空头像」，service 会写 NULL 而不是空串。
    avatar: Annotated[HttpUrl | None, Body(embed=True, description='头像地址，null 表示清空')] = None,
) -> ResponseModel:
    count = await user_service.update_avatar(db=db, user_id=request.user.id, avatar=avatar)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/me/timezone', summary='更新当前用户显示时区', dependencies=[DependsJwtAuth])
async def update_user_timezone(
    db: CurrentSessionTransaction,
    request: Request,
    # 只挂 DependsJwtAuth，不挂权限码：这是**个人偏好**，和头像/邮箱同一类，
    # 每个登录用户都该能改自己的，不需要管理员授权。
    #
    # 入参类型是 `IanaTimeZone` 而不是裸 str —— 校验必须在写入侧做，
    # 理由见 `common/schema.py` 里那个校验函数的注释（存进一个拼错的时区名，
    # 那个用户所有带时间的页面都会白屏，而且自己改不回来）。
    timezone: Annotated[IanaTimeZone, Body(embed=True, description='IANA 时区标识，如 Asia/Shanghai')],
) -> ResponseModel:
    count = await user_service.update_timezone(db=db, user_id=request.user.id, tz=timezone)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.put('/me/email', summary='更新当前用户邮箱', dependencies=[DependsJwtAuth])
async def update_user_email(
    db: CurrentSessionTransaction,
    request: Request,
    captcha: Annotated[str, Body(embed=True, description='邮箱验证码')],
    email: Annotated[str, Body(embed=True, description='用户邮箱')],
) -> ResponseModel:
    count = await user_service.update_email(db=db, user_id=request.user.id, captcha=captcha, email=email)
    if count > 0:
        return response_base.success()
    return response_base.fail()


@router.delete(
    path='/{pk}',
    summary='删除用户',
    dependencies=[
        Depends(RequestPermission('sys:user:del')),
        DependsRBAC,
    ],
)
async def delete_user(db: CurrentSessionTransaction, pk: Annotated[int, Path(description='用户 ID')]) -> ResponseModel:
    count = await user_service.delete(db=db, pk=pk)
    if count > 0:
        return response_base.success()
    return response_base.fail()
