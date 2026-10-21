from datetime import datetime
from typing import Any

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.log import log
from backend.common.pagination import paging_data
from backend.database.db import async_db_session
from backend.plugin.open.crud.crud_api_log import open_api_log_dao
from backend.plugin.open.model import OpenApiLog, OpenApp
from backend.utils.timezone import timezone


async def write_api_log(entry: dict[str, Any]) -> None:
    """落一条调用日志，顺带更新应用的「最近调用时间」（同一个事务）。

    🔴 这里自己开会话（响应发完之后在后台任务里跑，没有依赖注入可用）——
    所以这个模块登记在 `backend/conftest.py` 的 `_PATCHED_SESSION_MODULES` 里，
    不登记的话跑测试会往**开发库**写调用日志。
    """
    entry = dict(entry)
    touch_app_id = entry.pop('touch_app_id', None)
    try:
        async with async_db_session.begin() as db:
            db.add(OpenApiLog(**entry))
            if touch_app_id is not None:
                await db.execute(
                    update(OpenApp).where(OpenApp.id == touch_app_id).values(last_used_time=timezone.now())
                )
    except Exception:
        # 日志写不进去不能让调用方的请求失败（响应已经发出去了），但要留痕
        log.exception('开放接口调用日志写入失败')


class OpenApiLogService:
    @staticmethod
    async def get_list(
        *,
        db: AsyncSession,
        app_id: int | None,
        status: int | None,
        error_code: str | None,
        path: str | None,
        ip: str | None,
        start_time: datetime | None,
        end_time: datetime | None,
    ) -> dict[str, Any]:
        stmt = await open_api_log_dao.get_select(
            app_id=app_id,
            status=status,
            error_code=error_code,
            path=path,
            ip=ip,
            start_time=start_time,
            end_time=end_time,
        )
        return await paging_data(db, stmt)


open_api_log_service: OpenApiLogService = OpenApiLogService()
