from datetime import datetime

from sqlalchemy import Select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.sms.model import SmsLog
from backend.utils.timezone import timezone


class CRUDSmsLog(DataScopedCRUD[SmsLog]):
    """短信发送日志的数据库操作类"""

    # 审计记录，和操作日志同一口径：不按数据范围过滤，访问控制由 `sms:log:*` 权限码负责
    data_scope_enabled = False

    async def get(self, db: AsyncSession, pk: int) -> SmsLog | None:
        return await self.select_model(db, pk)

    async def get_select(
        self,
        *,
        phone: str | None = None,
        config_id: int | None = None,
        template: str | None = None,
        status: int | None = None,
        error_kind: str | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        """列表筛选。

        ⚠️ 这里的关键字参数、接口的查询参数、接口往下传的那一行，三者要对齐 —— 断任何一层都是
        「死控件」（AI 插件 `TestLogFilterParams` 记过）。守卫：`tests/test_sms_log_api.py::TestLogFilterParams`
        """
        kwargs: dict[str, object] = {}
        if phone:
            # 全等：手机号是精确键，模糊匹配只会把别人的号码也翻出来
            kwargs['phone'] = phone
        if config_id is not None:
            kwargs['config_id'] = config_id
        if template:
            kwargs['template'] = template
        if status is not None:
            kwargs['status'] = status
        if error_kind:
            kwargs['error_kind'] = error_kind
        if start_time is not None:
            kwargs['created_time__ge'] = start_time
        if end_time is not None:
            kwargs['created_time__le'] = end_time
        return await self.select_order('id', 'desc', **kwargs)

    async def settle(self, db: AsyncSession, pk: int, **values: object) -> int:
        """两段式的第二段：把「发送中」更新成终态。Core update，不先查（这一行刚由另一个会话插入）"""
        result = await db.execute(update(SmsLog).where(SmsLog.id == pk).values(updated_time=timezone.now(), **values))
        return result.rowcount or 0

    async def delete(self, db: AsyncSession, pks: list[int]) -> int:
        """硬删（审计记录不走软删）"""
        result = await db.execute(delete(SmsLog).where(SmsLog.id.in_(pks)))
        return result.rowcount or 0

    async def delete_all(self, db: AsyncSession) -> int:
        result = await db.execute(delete(SmsLog))
        return result.rowcount or 0


sms_log_dao: CRUDSmsLog = CRUDSmsLog(SmsLog)
