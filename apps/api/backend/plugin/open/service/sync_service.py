"""增量同步：按「变更时间 + id」做游标分页，**连已删除的行一起**返回。

三个容易静默出错的地方（都有测试）：

- 🔴 变更时间要用 `COALESCE(updated_time, created_time)`：`DateTimeMixin.updated_time` 可空，
  新插入的行是 NULL，只按 `updated_time` 查会**漏掉所有新增**
- 🔴 软删的行也要返回（`deleted: true`），否则对方永远不知道哪条没了 —— 和平时 `deleted = 0` 正好相反，
  所以这里**直接写 select、不走 DAO**（DAO 的查询都带着 `deleted = 0`）
- 游标比较不能写行值比较 `(t, id) > (:t, :id)`：SQL Server 不支持。展开成 `t > :t OR (t = :t AND id > :id)`
- 🔴 SQL Server 的 `datetimeoffset(7)` 精确到 100ns，Python `datetime` 只到微秒：库里生成的时间（种子的 `GETDATE()`）
  读出来被截掉一截，游标里的 `t` 比真值小一点点，`t > :t` 对**同一行**永远成立 —— 同一页、同一个 `next_cursor`
  无限返回，对方的同步循环永远停不下来。所以 SQL Server 上先 `CAST(... AS DATETIMEOFFSET(6))`，
  取值、比较、排序用的是同一个微秒精度的值

用游标不用 offset：同步过程中数据还在变，offset 会漏或重。
"""

import base64
import json

from datetime import datetime
from typing import Any

from sqlalchemy import and_, cast, func, or_, select
from sqlalchemy.dialects.mssql import DATETIMEOFFSET
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.model import Dept, User
from backend.common.enums import DataBaseType
from backend.core.conf import settings
from backend.plugin.open.gateway.errors import OpenApiError


def encode_cursor(changed: datetime, pk: int) -> str:
    raw = json.dumps({'t': changed.isoformat(), 'i': str(pk)}, separators=(',', ':')).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')


def decode_cursor(cursor: str) -> tuple[datetime, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor + '=' * (-len(cursor) % 4))
        data = json.loads(raw)
        return datetime.fromisoformat(data['t']), int(data['i'])
    except Exception as e:
        raise OpenApiError(400, 'open.bad_cursor') from e


async def _sync(
    db: AsyncSession,
    model: Any,
    *,
    updated_since: datetime | None,
    cursor: str | None,
    limit: int,
) -> tuple[list[Any], str | None, bool]:
    changed = func.coalesce(model.updated_time, model.created_time)
    if DataBaseType.sqlserver == settings.DATABASE_TYPE:
        changed = cast(changed, DATETIMEOFFSET(6))
    stmt = select(model, changed.label('changed'))
    if updated_since is not None:
        stmt = stmt.where(changed >= updated_since)
    if cursor:
        t, pk = decode_cursor(cursor)
        stmt = stmt.where(or_(changed > t, and_(changed == t, model.id > pk)))
    stmt = stmt.order_by(changed, model.id).limit(limit + 1)
    rows = (await db.execute(stmt)).all()
    has_more = len(rows) > limit
    rows = rows[:limit]
    next_cursor = encode_cursor(rows[-1].changed, rows[-1][0].id) if has_more else None
    return [r[0] for r in rows], next_cursor, has_more


def _sid(v: int | None) -> str | None:
    return str(v) if v is not None else None


async def sync_users(
    db: AsyncSession, *, updated_since: datetime | None, cursor: str | None, limit: int
) -> tuple[list[dict[str, Any]], str | None, bool]:
    users, next_cursor, has_more = await _sync(db, User, updated_since=updated_since, cursor=cursor, limit=limit)
    items = [
        {
            'id': str(u.id),
            'username': u.username,
            'nickname': u.nickname,
            'dept_id': _sid(u.dept_id),
            'status': u.status,
            'deleted': u.deleted != 0,
            'created_time': u.created_time,
            'updated_time': u.updated_time,
        }
        for u in users
    ]
    return items, next_cursor, has_more


async def sync_depts(
    db: AsyncSession, *, updated_since: datetime | None, cursor: str | None, limit: int
) -> tuple[list[dict[str, Any]], str | None, bool]:
    depts, next_cursor, has_more = await _sync(db, Dept, updated_since=updated_since, cursor=cursor, limit=limit)
    items = [
        {
            'id': str(d.id),
            'parent_id': _sid(d.parent_id),
            'code': d.code,
            'name': d.name,
            'sort': d.sort,
            'leader_id': _sid(d.leader_id),
            'status': d.status,
            'deleted': d.deleted != 0,
            'created_time': d.created_time,
            'updated_time': d.updated_time,
        }
        for d in depts
    ]
    return items, next_cursor, has_more
