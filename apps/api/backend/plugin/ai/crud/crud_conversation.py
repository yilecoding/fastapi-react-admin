from collections.abc import Sequence

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.ai.model import AiConversation, AiMessage
from backend.utils.timezone import timezone


class CRUDAiConversation(DataScopedCRUD[AiConversation]):
    """AI 会话的数据库操作类"""

    # 会话是**按人**过滤的：每一条查询都强制带 `user_id == 当前用户`（见下面每个方法）。
    # 再叠一层 fail-open 的数据范围只会把「我的会话」变成「我和我下属的会话」——语义直接错。
    # 同 `crud_notification` 的收件箱那条。
    data_scope_enabled = False

    async def get_owned(self, db: AsyncSession, pk: int, user_id: int) -> AiConversation | None:
        """取一个**属于这个用户的**会话。

        🔴 `user_id` 不是可选的过滤条件，是所有权校验本身。少带它就是越权读别人的对话，
        而对话里可能有他部门之外的业务数据。
        """
        return await self.select_model_by_column(db, id=pk, user_id=user_id, deleted=0)

    async def get_select(self, user_id: int, *, title: str | None = None) -> Select:
        kwargs: dict[str, object] = {'user_id': user_id, 'deleted': 0}
        if title:
            kwargs['title__like'] = f'%{title}%'
        return await self.select_order('id', 'desc', **kwargs)

    async def delete(self, db: AsyncSession, pk: int, user_id: int) -> int:
        """软删一个**属于这个用户的**会话。

        🔴 `user_id` 带在条件里而不是只在 service 层先查一次：少了它，
        拿到别人的会话 ID 就能删掉别人的对话。
        `deleted_flag_value` 用行自己的 id，理由同 `crud_provider.delete`。
        """
        return await self.delete_model_by_column(
            db,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id=pk,
            user_id=user_id,
            deleted=0,
        )

    async def create(self, db: AsyncSession, *, user_id: int, title: str, provider_id: int | None) -> AiConversation:
        obj = AiConversation(user_id=user_id, title=title, provider_id=provider_id)
        db.add(obj)
        await db.flush()
        return obj


class CRUDAiMessage(DataScopedCRUD[AiMessage]):
    """AI 会话消息的数据库操作类"""

    # 消息的可见性完全由它所属会话的所有权决定（调用方必须先过 `get_owned`），
    # 这张表自己没有可过滤维度。
    data_scope_enabled = False

    async def create(
        self,
        db: AsyncSession,
        *,
        conversation_id: int,
        role: str,
        content: str,
        tool_calls: str | None = None,
        tool_call_id: str | None = None,
    ) -> AiMessage:
        obj = AiMessage(
            conversation_id=conversation_id,
            role=role,
            content=content,
            tool_calls=tool_calls,
            tool_call_id=tool_call_id,
        )
        db.add(obj)
        await db.flush()
        return obj

    async def get_history(self, db: AsyncSession, conversation_id: int, limit: int = 50) -> Sequence[AiMessage]:
        """取最近 N 条消息，**按时间正序**返回。

        ⚠️ 取的时候按 id 倒序 + limit（要的是"最近"），返回前再翻正过来 ——
        直接正序 + limit 拿到的是**最早**的 N 条，表现为"AI 记不住刚说过的话"，
        而且对话越长越明显。
        """
        stmt = (
            select(AiMessage)
            .where(AiMessage.conversation_id == conversation_id)
            .order_by(AiMessage.id.desc())
            .limit(limit)
        )
        rows = (await db.execute(stmt)).scalars().all()
        return list(reversed(rows))


ai_conversation_dao: CRUDAiConversation = CRUDAiConversation(AiConversation)
ai_message_dao: CRUDAiMessage = CRUDAiMessage(AiMessage)
