from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request

from backend.common.response.response_schema import ResponseSchemaModel, response_base
from backend.database.db import CurrentSession
from backend.plugin.open.gateway.auth import DependsOpenApp, call_context
from backend.plugin.open.gateway.route import OpenApiRoute
from backend.plugin.open.schema.open_v1 import OpenDeptOut, OpenUserOut, SyncPage
from backend.plugin.open.service.sync_service import sync_depts, sync_users

# 🔴 每个开放接口都必须挂 `DependsOpenApp`（`tests/test_open_api.py` 遍历路由守着）：
# 漏挂的那个接口不用签名、谁都能调，而且 JWT 中间件也会放行它（没带 Bearer = 「未认证」而不是「认证失败」）
router = APIRouter(route_class=OpenApiRoute)

_SINCE = Query(description='只要这个时间之后变更过的（含删除），带时区的 ISO 8601；第一次全量同步不传')
_CURSOR = Query(description='上一页返回的 next_cursor，原样带回')
_LIMIT = Query(ge=1, le=500, description='每页条数，1–500')


@router.get(
    '/users',
    summary='读取用户（增量同步）',
    dependencies=[Depends(DependsOpenApp('user:read', '读取用户'))],
)
async def open_sync_users(
    request: Request,
    db: CurrentSession,
    updated_since: Annotated[datetime | None, _SINCE] = None,
    cursor: Annotated[str | None, _CURSOR] = None,
    limit: Annotated[int, _LIMIT] = 100,
) -> ResponseSchemaModel[SyncPage[OpenUserOut]]:
    items, next_cursor, has_more = await sync_users(db, updated_since=updated_since, cursor=cursor, limit=limit)
    call_context(request).row_count = len(items)
    return response_base.success(data={'items': items, 'next_cursor': next_cursor, 'has_more': has_more})


@router.get(
    '/depts',
    summary='读取部门（增量同步）',
    dependencies=[Depends(DependsOpenApp('dept:read', '读取部门'))],
)
async def open_sync_depts(
    request: Request,
    db: CurrentSession,
    updated_since: Annotated[datetime | None, _SINCE] = None,
    cursor: Annotated[str | None, _CURSOR] = None,
    limit: Annotated[int, _LIMIT] = 100,
) -> ResponseSchemaModel[SyncPage[OpenDeptOut]]:
    items, next_cursor, has_more = await sync_depts(db, updated_since=updated_since, cursor=cursor, limit=limit)
    call_context(request).row_count = len(items)
    return response_base.success(data={'items': items, 'next_cursor': next_cursor, 'has_more': has_more})
