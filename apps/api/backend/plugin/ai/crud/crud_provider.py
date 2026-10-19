from sqlalchemy import Select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.ai.model import AiProvider
from backend.utils.timezone import timezone


class CRUDAiProvider(DataScopedCRUD[AiProvider]):
    """AI 供应商的数据库操作类"""

    # 供应商是**系统级配置**（同 sys_config），不是归属某个部门/某个人的业务数据，
    # 按数据范围过滤没有意义。访问控制由 `ai:provider:*` 权限码负责。
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> AiProvider | None:
        return await self.select_model(db, pk, deleted=0)

    async def get_by_name(self, db: AsyncSession, name: str) -> AiProvider | None:
        """按名称查重（非展示读，只服务于创建/更新时的冲突检查）"""
        return await self.select_model_by_column(db, name=name, deleted=0)

    async def get_default(self, db: AsyncSession) -> AiProvider | None:
        """取默认供应商：优先 is_default，其次任意一个启用的

        兜底那一半是刻意的：管理员把默认的那个停用了，对话不该直接不可用 ——
        那种失败的表现是「点了发送没反应」，比「换了个模型回答」难查得多。
        """
        obj = await self.select_model_by_column(db, is_default=True, status=1, deleted=0)
        if obj is not None:
            return obj
        return await self.select_model_by_column(db, status=1, deleted=0)

    async def get_select(self, *, name: str | None = None, status: int | None = None) -> Select:
        kwargs: dict[str, object] = {'deleted': 0}
        if name:
            kwargs['name__like'] = f'%{name}%'
        if status is not None:
            kwargs['status'] = status
        return await self.select_order('id', 'desc', **kwargs)

    async def delete(self, db: AsyncSession, pk: int) -> int:
        """软删一个供应商。

        🔴 `deleted_flag_value` 必须是**这一行自己的 id**，不是 `True`。
        `deleted` 列是「0 或这一行自己的 id」（`LogicalDeleteMixin`，硬纪律），
        写成布尔会落成 1 —— 含可空列的唯一约束在软删后就再也插不进同一个键了。
        """
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

    async def clear_default(self, db: AsyncSession, exclude_pk: int | None = None) -> None:
        """把其它供应商的 is_default 清掉（默认供应商只能有一个）

        ⚠️ 用整表 UPDATE 而不是「先查出来再逐个改」：并发下后者会留下两个默认值，
        而「有两个默认」的表现是每次对话随机用其中一个，极难复现。
        """
        # 🔴 布尔列用 `== True` 而不是 `.is_(True)`。后者在 SQL Server 上编译成
        # `is_default IS 1` —— **非法 T-SQL，接口直接 500**（实测：创建默认供应商时
        # `Incorrect syntax near '1'`）。同一族的坑在 `app/task/tests/test_scheduler.py`
        # 记过一次：`deleted.is_(False)` 在 SQL Server 上更阴，不报错、只是永远匹配不到。
        stmt = update(AiProvider).where(AiProvider.is_default == True, AiProvider.deleted == 0)  # ruff: ignore[true-false-comparison]
        if exclude_pk is not None:
            stmt = stmt.where(AiProvider.id != exclude_pk)
        await db.execute(stmt.values(is_default=False))


ai_provider_dao: CRUDAiProvider = CRUDAiProvider(AiProvider)
