from datetime import timedelta

from sqlalchemy import Select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.ai.model import AiMcpClient
from backend.utils.timezone import timezone

# 最近使用时间只为「发现不再用的凭据」服务，精确到分钟足够；
# 每个请求都写一次的话，一个高频调用方就是一个高频写库的来源
_LAST_USED_RESOLUTION = timedelta(minutes=1)


class CRUDAiMcpClient(DataScopedCRUD[AiMcpClient]):
    """MCP 凭据的数据库操作类"""

    # 系统级配置（同供应商），访问控制靠 `ai:mcp:*` 权限码，不按数据范围过滤
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> AiMcpClient | None:
        return await self.select_model(db, pk, deleted=0)

    async def get_by_client_id(self, db: AsyncSession, client_id: str) -> AiMcpClient | None:
        return await self.select_model_by_column(db, client_id=client_id, deleted=0)

    async def get_active_by_token_hash(self, db: AsyncSession, token_sha256: str) -> AiMcpClient | None:
        """按令牌哈希查。直接走索引等值查询：比对的是哈希，响应时间泄露不出明文的任何信息"""
        return await self.select_model_by_column(db, token_sha256=token_sha256, status=1, deleted=0)

    async def get_select(self, *, name: str | None = None, status: int | None = None) -> Select:
        kwargs: dict[str, object] = {'deleted': 0}
        if name:
            kwargs['name__like'] = f'%{name}%'
        if status is not None:
            kwargs['status'] = status
        return await self.select_order('id', 'desc', **kwargs)

    async def touch(self, db: AsyncSession, obj: AiMcpClient) -> None:
        now = timezone.now()
        if obj.last_used_time is not None and now - obj.last_used_time < _LAST_USED_RESOLUTION:
            return
        await db.execute(update(AiMcpClient).where(AiMcpClient.id == obj.id).values(last_used_time=now))

    async def delete(self, db: AsyncSession, pk: int) -> int:
        """软删。`deleted_flag_value` 是这一行自己的 id（`LogicalDeleteMixin`，见 crud_provider 的同一条）"""
        return await self.delete_model_by_column(
            db,
            logical_deletion=True,
            deleted_flag_column='deleted',
            deleted_flag_value=self.model.id,
            deleted_at_column='deleted_time',
            deleted_at_factory=timezone.now(),
            id=pk,
            deleted=0,
        )


ai_mcp_client_dao: CRUDAiMcpClient = CRUDAiMcpClient(AiMcpClient)
