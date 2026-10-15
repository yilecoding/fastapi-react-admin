from datetime import datetime

from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.ai.model import AiToolInvocation


class CRUDAiToolInvocation(DataScopedCRUD[AiToolInvocation]):
    """AI 工具调用审计的数据库操作类"""

    # 审计表没有 dept_id / created_by 这类可过滤维度，挂上数据范围只会有
    # fail-closed 一种效果（同公告那条：开了过滤又没配范围 = 一条都看不见）。
    # 访问控制由接口上的 `ai:log:list` 权限码负责。
    data_scope_enabled = False

    async def create(self, db: AsyncSession, **kwargs: object) -> AiToolInvocation:
        """落一行审计"""
        obj = AiToolInvocation(**kwargs)  # type: ignore[arg-type]
        db.add(obj)
        await db.flush()
        return obj

    async def get_select(
        self,
        *,
        tool_name: str | None = None,
        status: int | None = None,
        user_id: int | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        """审计列表查询表达式"""
        kwargs: dict[str, object] = {}
        if tool_name:
            kwargs['tool_name__like'] = f'%{tool_name}%'
        if status is not None:
            kwargs['status'] = status
        if user_id is not None:
            kwargs['user_id'] = user_id
        # 审计基本都是「看某段时间内发生了什么」，没有时间范围很难用（同登录日志）。
        # `created_time` 上有索引，范围查不会全表扫
        if start_time is not None:
            kwargs['created_time__ge'] = start_time
        if end_time is not None:
            kwargs['created_time__le'] = end_time
        # 分页必须带 ORDER BY（SQL Server 的 OFFSET FETCH 强制要求）；
        # 排 id 不排 created_time —— 同一毫秒内批量插入会撞值，撞了翻页行序会变
        return await self.select_order('id', 'desc', **kwargs)


ai_tool_invocation_dao: CRUDAiToolInvocation = CRUDAiToolInvocation(AiToolInvocation)
