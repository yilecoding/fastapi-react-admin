from sqlalchemy import Select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.open.model import OpenApp
from backend.utils.timezone import timezone


class CRUDOpenApp(DataScopedCRUD[OpenApp]):
    """能力开放应用的数据库操作类"""

    # 系统级配置（同 MCP 凭据），访问控制靠 `open:app:*` 权限码，不按数据范围过滤
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> OpenApp | None:
        return await self.select_model(db, pk, deleted=0)

    async def get_by_code(self, db: AsyncSession, code: str) -> OpenApp | None:
        return await self.select_model_by_column(db, code=code, deleted=0)

    async def get_by_access_key(self, db: AsyncSession, access_key: str) -> OpenApp | None:
        """按 AK 查（含停用 / 过期的 —— 鉴权要给出具体原因，而不是一律「AK 无效」）"""
        return await self.select_model_by_column(db, access_key=access_key, deleted=0)

    async def get_select(self, *, name: str | None = None, status: int | None = None) -> Select:
        stmt = await self.select_order('id', 'desc', deleted=0)
        if name:
            # 一个框同时搜名称和编码（编码大小写归一，同部门 / 角色的 code 筛选）
            stmt = stmt.where(or_(OpenApp.name.like(f'%{name}%'), OpenApp.code.like(f'%{name.upper()}%')))
        if status is not None:
            # 「已过期」不是库里的状态（库里只有启用 / 停用），按失效时间算
            now = timezone.now()
            if status == 2:
                stmt = stmt.where(OpenApp.status == 1, OpenApp.expire_time.is_not(None), OpenApp.expire_time <= now)
            elif status == 1:
                stmt = stmt.where(OpenApp.status == 1, or_(OpenApp.expire_time.is_(None), OpenApp.expire_time > now))
            else:
                stmt = stmt.where(OpenApp.status == status)
        return stmt

    async def delete(self, db: AsyncSession, pk: int) -> int:
        """软删。`deleted_flag_value` 是这一行自己的 id（`LogicalDeleteMixin`），删了能用同一个编码重建"""
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


open_app_dao: CRUDOpenApp = CRUDOpenApp(OpenApp)
