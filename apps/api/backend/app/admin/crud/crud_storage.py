from collections.abc import Sequence

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import Storage
from backend.common.security.data_scope import DataScopedCRUD
from backend.utils.timezone import timezone


class CRUDStorage(DataScopedCRUD[Storage]):
    """存储数据库操作类"""

    # 存储是**系统级配置**（同 AI 供应商 / sys_config），不归属某个部门或某个人，
    # 按数据范围过滤没有意义。访问控制由 `sys:storage:*` 权限码负责 ——
    # 而读文件那条路（下载 / `/uploads`）只挂登录甚至不挂，过滤了就是「这个人读不到文件」
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> Storage | None:
        return await self.select_model(db, pk, deleted=0)

    async def get_by_code(self, db: AsyncSession, code: str) -> Storage | None:
        return await self.select_model_by_column(db, code=code, deleted=0)

    async def get_default(self, db: AsyncSession) -> Storage | None:
        """默认存储。None = 内置本地存储"""
        return await self.select_model_by_column(db, is_default=True, deleted=0)

    async def get_all(self, db: AsyncSession) -> Sequence[Storage]:
        return await self.select_models_order(db, 'id', 'asc', deleted=0)

    async def delete(self, db: AsyncSession, pk: int) -> int:
        """软删。`deleted_flag_value` 是这一行自己的 id，不是 True（LogicalDeleteMixin）"""
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

    async def clear_default(self, db: AsyncSession) -> None:
        """清掉所有默认标记（默认存储只能有一个；全清 = 回到内置本地存储）

        ⚠️ 整表 UPDATE 而不是先查后改：并发下后者会留下两个默认值（同 AI 供应商）
        """
        # 🔴 布尔列用 `== True`，不要 `.is_(True)` —— SQL Server 上编译成非法的 `IS 1`
        stmt = update(Storage).where(Storage.is_default == True, Storage.deleted == 0)  # ruff: ignore[true-false-comparison]
        await db.execute(stmt.values(is_default=False))


storage_dao: CRUDStorage = CRUDStorage(Storage)
