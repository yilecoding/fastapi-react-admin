from collections.abc import Sequence

from sqlalchemy import Select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.sms.model import SmsConfig
from backend.utils.timezone import timezone


class CRUDSmsConfig(DataScopedCRUD[SmsConfig]):
    """短信配置的数据库操作类"""

    # 系统级配置（同 ai_provider / sys_storage），不是归属某个部门的业务数据；访问控制由 `sms:config:*` 权限码负责
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> SmsConfig | None:
        return await self.select_model(db, pk, deleted=0)

    async def get_by_name(self, db: AsyncSession, name: str) -> SmsConfig | None:
        """按名称查重（非展示读，只服务于创建 / 更新时的冲突检查）"""
        return await self.select_model_by_column(db, name=name, deleted=0)

    async def get_enabled(self, db: AsyncSession) -> Sequence[SmsConfig]:
        """全部启用的配置 —— 选配置时**每次现查**，不缓存（多副本下改了配置即刻生效）"""
        return await self.select_models_order(db, 'id', 'asc', status=1, deleted=0)

    async def get_select(
        self, *, name: str | None = None, provider: str | None = None, status: int | None = None
    ) -> Select:
        kwargs: dict[str, object] = {'deleted': 0}
        if name:
            kwargs['name__like'] = f'%{name}%'
        if provider:
            kwargs['provider'] = provider
        if status is not None:
            kwargs['status'] = status
        return await self.select_order('id', 'desc', **kwargs)

    async def delete(self, db: AsyncSession, pk: int) -> int:
        """软删。🔴 `deleted_flag_value` 是**这一行自己的 id**，不是 True（`LogicalDeleteMixin`，硬纪律）"""
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
        """把其它配置的 is_default 清掉（默认只能有一条）。整表 UPDATE，不先查再改 —— 并发下后者会留下两个默认"""
        # 🔴 布尔列用 `== True` 不用 `.is_(True)`：后者在 SQL Server 上是非法 T-SQL（AI 插件实测 500）
        stmt = update(SmsConfig).where(SmsConfig.is_default == True, SmsConfig.deleted == 0)  # ruff: ignore[true-false-comparison]
        if exclude_pk is not None:
            stmt = stmt.where(SmsConfig.id != exclude_pk)
        await db.execute(stmt.values(is_default=False))


sms_config_dao: CRUDSmsConfig = CRUDSmsConfig(SmsConfig)
