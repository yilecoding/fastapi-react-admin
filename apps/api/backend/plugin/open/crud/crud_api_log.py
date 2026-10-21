from datetime import datetime

from sqlalchemy import Select

from backend.common.security.data_scope import DataScopedCRUD
from backend.plugin.open.model import OpenApiLog


class CRUDOpenApiLog(DataScopedCRUD[OpenApiLog]):
    """调用日志的数据库操作类"""

    # 系统级审计记录（同操作日志），访问控制靠 `open:log:list` 权限码，不按数据范围过滤
    data_scope_enabled = False

    async def get_select(
        self,
        *,
        app_id: int | None = None,
        status: int | None = None,
        error_code: str | None = None,
        path: str | None = None,
        ip: str | None = None,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Select:
        kwargs: dict[str, object] = {}
        if app_id is not None:
            kwargs['app_id'] = app_id
        if status is not None:
            kwargs['status'] = status
        if error_code:
            kwargs['error_code'] = error_code
        if path:
            kwargs['path__like'] = f'%{path}%'
        if ip:
            kwargs['ip__like'] = f'%{ip}%'
        if start_time is not None:
            kwargs['request_time__ge'] = start_time
        if end_time is not None:
            kwargs['request_time__le'] = end_time
        # 按雪花 id 倒序 = 按调用先后倒序（分页必须带 ORDER BY，SQL Server 的 OFFSET FETCH 强制）
        return await self.select_order('id', 'desc', **kwargs)


open_api_log_dao: CRUDOpenApiLog = CRUDOpenApiLog(OpenApiLog)
