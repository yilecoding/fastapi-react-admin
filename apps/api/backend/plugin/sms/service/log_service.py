from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.exception import errors
from backend.common.i18n import t
from backend.common.pagination import paging_data
from backend.core.conf import settings
from backend.plugin.sms.crud.crud_log import sms_log_dao
from backend.plugin.sms.enums import SmsLogStatus
from backend.plugin.sms.model import SmsLog
from backend.utils.timezone import timezone


def is_stale(status: int, created_time: datetime) -> bool:
    """「发送中」停留超过 `SMS_SENDING_STALE_SECONDS`：进程在两步之间崩溃了，日志页显示成「结果未知」

    库里的行**不改**：改了就分不清「厂商说未知」和「我们自己没写完」。
    """
    if status != SmsLogStatus.sending.value:
        return False
    return created_time < timezone.now() - timedelta(seconds=settings.SMS_SENDING_STALE_SECONDS)


class SmsLogService:
    """发送日志"""

    @staticmethod
    async def get(*, db: AsyncSession, pk: int) -> dict[str, Any]:
        row = await sms_log_dao.get(db, pk)
        if not row:
            raise errors.NotFoundError(msg=t('error.sms.log_not_found'))
        detail = {c.name: getattr(row, c.name) for c in SmsLog.__table__.columns}
        detail['stale'] = is_stale(row.status, row.created_time)
        return detail

    @staticmethod
    async def get_list(
        *,
        db: AsyncSession,
        phone: str | None,
        config_id: int | None,
        template: str | None,
        status: int | None,
        error_kind: str | None,
        start_time: datetime | None,
        end_time: datetime | None,
    ) -> dict[str, Any]:
        select = await sms_log_dao.get_select(
            phone=phone,
            config_id=config_id,
            template=template,
            status=status,
            error_kind=error_kind,
            start_time=start_time,
            end_time=end_time,
        )
        page = await paging_data(db, select)
        # `paging_data()` 返回的 items 是 dict（alembic 分册记过），按键取
        for item in page['items']:
            item['stale'] = is_stale(item['status'], item['created_time'])
        return page

    @staticmethod
    async def delete(*, db: AsyncSession, pks: list[int]) -> int:
        return await sms_log_dao.delete(db, pks)

    @staticmethod
    async def delete_all(*, db: AsyncSession) -> int:
        return await sms_log_dao.delete_all(db)


sms_log_service: SmsLogService = SmsLogService()
