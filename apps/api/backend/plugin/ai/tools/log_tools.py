"""日志域工具：安全排查与审计。

这两个工具是这套助手里**最接近真实运维场景**的：
「昨天有没有人登录失败」「谁改了角色配置」——人去翻日志页要点四五下、
还要自己拼筛选条件，问一句话就能拿到答案。
"""

from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.admin.crud.crud_login_log import login_log_dao
from backend.app.admin.crud.crud_opera_log import opera_log_dao
from backend.plugin.ai.core.registry import ai_tool
from backend.utils.timezone import timezone

_MAX_ROWS = 30


def _window(hours: int | None) -> tuple[datetime | None, datetime | None]:
    """把"最近 N 小时"换成起止时间。

    ⚠️ 用 `timezone.now()` 而不是 `datetime.now()`：全站单时区，
    裸 `datetime.now()` 取的是操作系统时区，在 CI（UTC）上会静默偏 8 小时
    （`apps/api/AGENTS.md` 里 `TimeZone.process_bind_param` 那条同源）。
    """
    if not hours:
        return None, None
    end = timezone.now()
    return end - timedelta(hours=hours), end


@ai_tool(
    name='login_log_list',
    description=(
        '查询登录日志，可按用户名、结果（status：0 失败 / 1 成功）、IP、最近 N 小时筛选。'
        '用户问"有谁登录失败""某某最近登录过吗""有没有异常登录"时用它。'
    ),
    domain='log',
    perm='log:login:list',
)
async def login_log_list(
    db: AsyncSession,
    username: str | None = None,
    status: int | None = None,
    ip: str | None = None,
    recent_hours: int | None = 24,
) -> dict[str, Any]:
    start, end = _window(recent_hours)
    stmt = await login_log_dao.get_select(username=username, status=status, ip=ip, start_time=start, end_time=end)
    rows = (await db.execute(stmt.limit(_MAX_ROWS))).scalars().all()
    return {
        'window_hours': recent_hours,
        'total_returned': len(rows),
        'truncated': len(rows) == _MAX_ROWS,
        'logs': [
            {
                'username': r.username,
                'status': r.status,
                'ip': r.ip,
                'location': ' '.join(x for x in (r.country, r.region, r.city) if x) or None,
                'browser': r.browser,
                'os': r.os,
                'msg': r.msg,
                'login_time': r.login_time.isoformat() if r.login_time else None,
            }
            for r in rows
        ],
    }


@ai_tool(
    name='opera_log_list',
    description=(
        '查询操作日志（谁在什么时候改了什么），可按用户名、结果、IP、最近 N 小时筛选。'
        '用户问"谁改了角色""最近有哪些写操作""某某今天做了什么"时用它。'
    ),
    domain='log',
    perm='log:opera:list',
)
async def opera_log_list(
    db: AsyncSession,
    username: str | None = None,
    status: int | None = None,
    ip: str | None = None,
    recent_hours: int | None = 24,
) -> dict[str, Any]:
    """🔴 **刻意不返回 `args` / `request_headers` / `response_body`。**

    那三个字段才是操作日志里真正有价值也真正敏感的部分（请求体里有业务数据、
    头里有凭据痕迹）。它们会原样进模型上下文并发给供应商——中间件那边花力气做的
    脱敏，不该在这里被一个"顺手全都带上"抵消掉。要看详情去操作日志页。
    """
    start, end = _window(recent_hours)
    stmt = await opera_log_dao.get_select(username=username, status=status, ip=ip, start_time=start, end_time=end)
    rows = (await db.execute(stmt.limit(_MAX_ROWS))).scalars().all()
    return {
        'window_hours': recent_hours,
        'total_returned': len(rows),
        'truncated': len(rows) == _MAX_ROWS,
        'logs': [
            {
                'username': r.username,
                'title': r.title,
                'method': r.method,
                'path': r.path,
                'status': r.status,
                'code': r.code,
                'cost_time_ms': r.cost_time,
                'opera_time': r.opera_time.isoformat() if r.opera_time else None,
            }
            for r in rows
        ],
    }
