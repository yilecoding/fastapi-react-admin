"""工作台「系统运行」区的三块数据（#202）：需要你留意 · 服务状态 · 近 N 天访问。

每块一个接口：一块挂了只影响那一张卡片（硬纪律 9 要的是「失败看得见」，不是「一个失败拖垮一整片」）。

🔴 **「需要你留意」按条目各自的权限过滤**，不是一个总开关：看得到定时任务的人不一定看得到 Webhook。
判据和那条目「去处理」要去的页面 / 接口一致 —— 判宽了是一条点进去 403 的提醒，判窄了是有权限的人看不到。
"""

from __future__ import annotations

import asyncio

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from sqlalchemy import case, func, select

from backend.app.admin.model import LoginLog
from backend.app.task.model import TaskExtended, TaskScheduler
from backend.common.security.session import SessionClient, session_store
from backend.core.conf import settings
from backend.plugin.core import check_plugin_installed
from backend.utils.timezone import timezone

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

#: 今天的登录失败「明显高于平时」：至少这么多次，并且不少于近 7 天日均的这么多倍。
#: 两个条件都要 —— 只看倍数的话，平时 0 次、今天 1 次也算「翻了无穷倍」
LOGIN_FAIL_MIN = 5
LOGIN_FAIL_RATIO = 2

#: 定时任务失败看最近多久
TASK_FAIL_WINDOW = timedelta(hours=24)

#: 访问柱状图最多看多少天
VISITS_MAX_DAYS = 31


def _perms_of(user: Any) -> tuple[bool, set[str]]:
    """`request.user` 的权限码。算法和 `common/security/rbac.py` 的 RBAC 校验一致（启用的角色 × 启用的菜单）"""
    perms: set[str] = set()
    for role in getattr(user, 'roles', None) or []:
        if role.status != 1:
            continue
        for menu in role.menus or []:
            if menu.perms and menu.status == 1:
                perms.update(menu.perms.split(','))
    return bool(user.is_superuser), perms


def _day_start(day: datetime) -> datetime:
    return day.replace(hour=0, minute=0, second=0, microsecond=0)


async def _login_counts(db: AsyncSession, start: datetime, end: datetime) -> tuple[int, int]:
    """[start, end) 之间的登录总数和失败数（一条查询，条件聚合）"""
    total, fails = (
        await db.execute(
            select(func.count(), func.sum(case((LoginLog.status == 0, 1), else_=0))).where(
                LoginLog.login_time >= start, LoginLog.login_time < end
            )
        )
    ).one()
    return int(total or 0), int(fails or 0)


async def visits(db: AsyncSession, *, days: int, tz: str | None) -> dict[str, Any]:
    """近 `days` 天每天的登录成功 / 失败次数（最后一天是今天）。

    「哪一天」按 `tz`（前端传的显示时区）切：服务端时区和查看人时区不同时，按服务端切会让柱子整体错位一天
    （原来前端拼 7 天趋势时专门记过这条）。每天一条条件聚合查询 —— 三个方言的「按天分组」表达式各不相同，
    而 14 条带索引的范围计数比一条方言相关的 GROUP BY 好维护得多
    """
    zone = ZoneInfo(tz) if tz else timezone.tz_info
    today = _day_start(datetime.now(zone))
    points = []
    for offset in range(days - 1, -1, -1):
        # 带 ZoneInfo 的 datetime 加减天数是「墙上时间」的加减：夏令时那天也落在当地 0 点，不是 ±24 小时
        start = today - timedelta(days=offset)
        end = start + timedelta(days=1)
        total, fails = await _login_counts(db, start, end)
        points.append({'date': start.date().isoformat(), 'total': total, 'fails': fails})
    return {'tz': str(zone), 'points': points}


async def attention(db: AsyncSession, user: Any) -> list[dict[str, Any]]:
    """要人动手的异常。只列「现在有问题、点过去能处理」的，每条带着它的去处所需的参数"""
    superuser, perms = _perms_of(user)

    def can(code: str) -> bool:
        return superuser or code in perms

    items: list[dict[str, Any]] = []
    if can('open:webhook:list') and check_plugin_installed('open'):
        items += await _disabled_webhooks(db)
    if can('task:scheduler:edit'):
        items += await _failed_tasks(db)
    if can('log:login:list'):
        items += await _login_fail_spike(db)
    return items


async def _disabled_webhooks(db: AsyncSession) -> list[dict[str, Any]]:
    """被**自动**停用的 Webhook 端点（连续投递失败到阈值）。手动停用的是人自己关的，不用提醒"""
    from backend.plugin.open.model import OpenWebhook

    rows = (
        await db.scalars(
            select(OpenWebhook)
            .where(OpenWebhook.status == 0, OpenWebhook.disabled_reason == 'auto')
            .order_by(OpenWebhook.disabled_time.desc(), OpenWebhook.id.desc())
        )
    ).all()
    return [
        {
            'kind': 'webhook_disabled',
            'level': 'critical',
            'name': w.name,
            'app_id': w.app_id,
            'time': w.disabled_time,
            'failures': w.consecutive_failures,
            'last_delivery_time': w.last_delivery_time,
        }
        for w in rows
    ]


async def _failed_tasks(db: AsyncSession) -> list[dict[str, Any]]:
    """最近 24 小时执行失败过的任务（按任务合并，最近一次在前），带上调度里起的名字和最后一行报错"""
    since = timezone.now() - TASK_FAIL_WINDOW
    rows = (
        await db.execute(
            select(TaskExtended.name, func.count(), func.max(TaskExtended.date_done))
            .where(TaskExtended.status == 'FAILURE', TaskExtended.date_done >= since)
            .group_by(TaskExtended.name)
        )
    ).all()
    if not rows:
        return []
    names = [n for n, _, _ in rows if n]
    titles = dict(
        (await db.execute(select(TaskScheduler.task, TaskScheduler.name).where(TaskScheduler.task.in_(names)))).all()
    )
    out = []
    for name, count, last in sorted(rows, key=lambda r: r[2] or since, reverse=True):
        tb = await db.scalar(
            select(TaskExtended.traceback)
            .where(TaskExtended.name == name, TaskExtended.status == 'FAILURE', TaskExtended.date_done >= since)
            .order_by(TaskExtended.date_done.desc(), TaskExtended.id.desc())
            .limit(1)
        )
        out.append({
            'kind': 'task_failed',
            'level': 'warning',
            'task': name,
            'name': titles.get(name) or name,
            'count': int(count),
            'time': last,
            # 栈的最后一行就是异常类型 + 信息（「TimeoutError: …」）。这块只有管理员看得到
            'error': _last_line(tb),
        })
    return out


def _last_line(tb: str | None) -> str | None:
    if not tb:
        return None
    lines = [ln.strip() for ln in tb.strip().splitlines() if ln.strip()]
    return lines[-1][:160] if lines else None


async def _login_fail_spike(db: AsyncSession) -> list[dict[str, Any]]:
    """今天的登录失败明显高于近 7 天的日均（今天不算进均值）"""
    today = _day_start(timezone.now())
    _, today_fails = await _login_counts(db, today, today + timedelta(days=1))
    if today_fails < LOGIN_FAIL_MIN:
        return []
    _, week_fails = await _login_counts(db, today - timedelta(days=7), today)
    avg = week_fails / 7
    if today_fails < LOGIN_FAIL_RATIO * avg:
        return []
    top = (
        await db.execute(
            select(LoginLog.ip, func.count().label('n'))
            .where(LoginLog.status == 0, LoginLog.login_time >= today)
            .group_by(LoginLog.ip)
            .order_by(func.count().desc(), LoginLog.ip)
            .limit(1)
        )
    ).first()
    return [
        {
            'kind': 'login_fail_spike',
            'level': 'warning',
            'count': today_fails,
            'avg': round(avg, 1),
            'top_ip': top[0] if top else None,
            'top_ip_count': int(top[1]) if top else 0,
        }
    ]


async def services() -> dict[str, Any]:
    """服务状态：和 `/health/status` 同一套检查（不另写一份），外加在线会话按端分"""
    # 延迟 import：registrar 在启动时 import 各路由，路由这边再在模块顶层 import 它就成环了
    from backend.core.registrar import _check_database, _check_heartbeats, _check_redis, _dependency

    db_err, redis_err, heartbeats = await asyncio.gather(_check_database(), _check_redis(), _check_heartbeats())
    services_ = {
        'api': {'status': 'ok'},
        'database': _dependency(db_err),
        'redis': _dependency(redis_err),
        **heartbeats,
    }
    by_client = {'web': 0, 'desktop': 0, 'mobile': 0}
    try:
        rows = await session_store.list_active()
    except Exception:  # 会话索引读不到（Redis 挂了）：上面 redis 那一项已经是 error，这里给 None 表示「不知道」
        rows = None
    if rows is not None:
        for row in rows:
            client = row.get('client')
            # swagger 调试口的会话不算（同在线用户页）
            if client == SessionClient.swagger:
                continue
            by_client[client if client in by_client else 'web'] += 1
    return {
        'status': 'ok' if all(s['status'] == 'ok' for s in services_.values()) else 'degraded',
        'services': services_,
        'heartbeat_max_age_seconds': settings.HEARTBEAT_MAX_AGE_SECONDS,
        'sessions': None if rows is None else {'total': sum(by_client.values()), **by_client},
    }
