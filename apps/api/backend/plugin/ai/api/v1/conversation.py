from typing import Annotated

from fastapi import APIRouter, Path, Query, Request

from backend.common.pagination import DependsPagination, PageData
from backend.common.response.response_schema import ResponseModel, ResponseSchemaModel, response_base
from backend.common.security.jwt import DependsJwtAuth
from backend.database.db import CurrentSession, CurrentSessionTransaction
from backend.plugin.ai.schema.conversation import (
    CreateConversationParam,
    GetConversationDetail,
    GetMessageDetail,
    UpdateConversationParam,
)
from backend.plugin.ai.service.conversation_service import conversation_service

router = APIRouter()

# 这批接口刻意**只挂 `DependsJwtAuth`**，不挂权限码：它们读写的全是「我自己的会话」，
# user_id 一律取自 `request.user.id`，不接受客户端传入 —— 越权面为零。
# 编一个权限码反而有害：种子漏挂到某个角色上，那个人的对话列表会永远是空的，
# 而界面上和「他确实没有会话」分不出来（硬纪律 9）。同 notification 的收件箱那批。


@router.get('', summary='分页获取我的会话', dependencies=[DependsJwtAuth, DependsPagination])
async def get_my_conversations(
    request: Request,
    db: CurrentSession,
    title: Annotated[str | None, Query(description='会话标题')] = None,
) -> ResponseSchemaModel[PageData[GetConversationDetail]]:
    page_data = await conversation_service.get_list(db=db, user_id=request.user.id, title=title)
    return response_base.success(data=page_data)


@router.post('', summary='新建会话', dependencies=[DependsJwtAuth])
async def create_conversation(
    request: Request, db: CurrentSessionTransaction, obj: CreateConversationParam
) -> ResponseSchemaModel[GetConversationDetail]:
    conversation = await conversation_service.create(db=db, user_id=request.user.id, obj=obj)
    return response_base.success(data=conversation)


@router.get('/{pk}/messages', summary='获取会话消息', dependencies=[DependsJwtAuth])
async def get_conversation_messages(
    request: Request, db: CurrentSession, pk: Annotated[int, Path(description='会话 ID')]
) -> ResponseSchemaModel[list[GetMessageDetail]]:
    data = await conversation_service.get_messages(db=db, pk=pk, user_id=request.user.id)
    return response_base.success(data=data)


@router.put('/{pk}', summary='重命名会话', dependencies=[DependsJwtAuth])
async def update_conversation(
    request: Request,
    db: CurrentSessionTransaction,
    pk: Annotated[int, Path(description='会话 ID')],
    obj: UpdateConversationParam,
) -> ResponseModel:
    await conversation_service.update(db=db, pk=pk, user_id=request.user.id, obj=obj)
    return response_base.success()


@router.delete('/{pk}', summary='删除会话', dependencies=[DependsJwtAuth])
async def delete_conversation(
    request: Request, db: CurrentSessionTransaction, pk: Annotated[int, Path(description='会话 ID')]
) -> ResponseModel:
    count = await conversation_service.delete(db=db, pk=pk, user_id=request.user.id)
    if count > 0:
        return response_base.success()
    return response_base.fail()
