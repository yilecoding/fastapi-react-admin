from datetime import datetime
from typing import Any

from pydantic import ConfigDict, Field

from backend.common.schema import SchemaBase


class GetOpenApiLogDetail(SchemaBase):
    """调用日志（字段和操作日志同口径，另加应用维度）"""

    model_config = ConfigDict(from_attributes=True)

    id: int
    trace_id: str
    app_id: int | None
    app_code: str | None
    app_name: str | None
    access_key: str | None
    method: str
    title: str
    path: str
    scope: str | None
    scope_granted: bool | None
    ip: str
    ip_whitelisted: bool | None
    country: str | None
    region: str | None
    city: str | None
    user_agent: str | None
    os: str | None
    browser: str | None
    device: str | None
    args: dict[str, Any] | None
    request_headers: dict[str, Any] | None
    response_headers: dict[str, Any] | None
    response_body: str | None
    status: int = Field(description='调用结果（0失败 1成功）')
    code: str = Field(description='HTTP 状态码')
    error_code: str = Field(description='ok 或失败原因')
    msg: str | None
    row_count: int | None
    cost_time: float
    request_time: datetime
