from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.pagination import paging_data
from backend.plugin.ai.crud.crud_conversation import ai_conversation_dao, ai_message_dao
from backend.plugin.ai.crud.crud_provider import ai_provider_dao
from backend.plugin.ai.model import AiConversation
from backend.plugin.ai.schema.conversation import CreateConversationParam, UpdateConversationParam


class ConversationService:
    """会话管理。所有方法都以 `user_id` 为所有权边界。"""

    @staticmethod
    async def get_owned(*, db: AsyncSession, pk: int, user_id: int) -> AiConversation:
        conversation = await ai_conversation_dao.get_owned(db, pk, user_id)
        if not conversation:
            # 🔴 别人的会话一律报「不存在」而不是「无权访问」——
            # 后者等于确认了"这个 ID 确实有一个会话"，是一个可枚举的信息泄露面
            raise errors.NotFoundError(msg='会话不存在')
        return conversation

    @staticmethod
    async def get_list(*, db: AsyncSession, user_id: int, title: str | None) -> dict[str, Any]:
        select = await ai_conversation_dao.get_select(user_id, title=title)
        return await paging_data(db, select)

    @staticmethod
    async def create(*, db: AsyncSession, user_id: int, obj: CreateConversationParam) -> AiConversation:
        provider_id = obj.provider_id
        if provider_id is None:
            default = await ai_provider_dao.get_default(db)
            provider_id = default.id if default else None
        return await ai_conversation_dao.create(db, user_id=user_id, title=obj.title, provider_id=provider_id)

    @classmethod
    async def update(cls, *, db: AsyncSession, pk: int, user_id: int, obj: UpdateConversationParam) -> int:
        conversation = await cls.get_owned(db=db, pk=pk, user_id=user_id)
        conversation.title = obj.title
        await db.flush()
        return 1

    @classmethod
    async def delete(cls, *, db: AsyncSession, pk: int, user_id: int) -> int:
        await cls.get_owned(db=db, pk=pk, user_id=user_id)
        return await ai_conversation_dao.delete(db, pk, user_id)

    @classmethod
    async def get_messages(cls, *, db: AsyncSession, pk: int, user_id: int) -> list[Any]:
        await cls.get_owned(db=db, pk=pk, user_id=user_id)
        # 只回放 user / assistant 两类：tool 消息是给模型看的中间过程，
        # 摊给用户只会让对话记录看起来像一堆乱码 JSON。要看工具做了什么去审计页。
        messages = await ai_message_dao.get_history(db, pk, limit=200)
        return [m for m in messages if m.role in ('user', 'assistant') and m.content]


conversation_service: ConversationService = ConversationService()
