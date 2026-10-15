"""系统域工具：不读业务数据，只回答"系统本身怎么样"。"""

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend import __version__
from backend.common.log import log
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.ai.core.ports import RunContext
from backend.plugin.ai.core.registry import ai_tool


@ai_tool(
    name='system_health_check',
    description='检查系统健康状态，返回数据库与 Redis 的连通性。用户问"系统正常吗/有没有挂"时用它。',
    domain='system',
    # perm=None：它不读任何业务数据，只回答"连得上吗"。给它编一个权限码反而有害 ——
    # 种子里漏挂到某个角色上，那个人问"系统正常吗"会得到"你没有权限"，而这不是权限问题。
    perm=None,
)
async def system_health_check(db: AsyncSession) -> dict[str, Any]:
    # ⚠️ 版本号在 `backend/__init__.py: __version__`，**不在 settings 里**。
    # 第一版写的是 `settings.FASTAPI_VERSION`（那个字段根本不存在）——
    # 表现是健康检查整个失败、AI 回答"系统可能已异常"，而系统是好的。
    # 工具里访问 settings 的字段前先确认它真的存在：拼错不会有任何静态信号。
    result: dict[str, Any] = {'app': settings.FASTAPI_TITLE, 'version': __version__}

    try:
        await db.execute(text('SELECT 1'))
        result['database'] = 'ok'
    except Exception as e:  # 健康检查本身不该抛 —— 它的职责就是如实报告坏消息
        log.warning(f'AI 健康检查：数据库不可达 {e}')
        result['database'] = f'error: {e}'

    try:
        await redis_client.ping()
        result['redis'] = 'ok'
    except Exception as e:
        log.warning(f'AI 健康检查：Redis 不可达 {e}')
        result['redis'] = f'error: {e}'

    return result


@ai_tool(
    name='system_whoami',
    description='获取当前对话用户自己的信息（用户名、昵称、是否超管、所属部门与角色）。用户问"我是谁/我有什么权限"时用它。',
    domain='system',
    perm=None,
)
async def system_whoami(ctx: RunContext) -> dict[str, Any]:  # ruff: ignore[unused-async] —— 工具协议要求 async，见 registry
    """只回答**关于调用者自己**的事实，所以不需要权限码（同"我的收件箱"那类接口）。"""
    user = ctx.user
    return {
        'id': str(user.id),
        'username': user.username,
        'nickname': getattr(user, 'nickname', None),
        'is_superuser': bool(user.is_superuser),
        'is_staff': bool(user.is_staff),
        'dept': getattr(getattr(user, 'dept', None), 'name', None),
        'roles': [role.name for role in (user.roles or [])],
    }
