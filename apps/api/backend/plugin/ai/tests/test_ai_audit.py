"""审计落库失败不能把同一个会话里后面的事情一起带崩。

🔴 `_audit` 吞掉异常、注释写着「不影响本次调用结果」—— 吞掉的只是 Python 异常，
**会话本身已经坏了**：flush 失败之后 SQLAlchemy 把整个事务标成待回滚，之后同一个
会话上的任何查询都是 `PendingRollbackError`。表现是：一次审计写失败，这一轮对话里
后面每一个工具都「执行失败」，模型对着一串失败反复重试到轮数上限 —— 实测踩过
（脚本里没初始化雪花算法，审计取不到 ID；线上换成任何一次插入失败都是同一个形状）。

修法是审计放进 SAVEPOINT（`begin_nested`），失败只回滚那一行。

这里用一个**名字超过列宽（64）**的工具触发真实的数据库报错，不 mock DAO ——
要验证的恰恰是「数据库层面的失败」之后会话还能不能用。
"""

import asyncio

from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import func, select

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import _REGISTRY, ai_tool, load_builtin_tools
from backend.plugin.ai.model import AiToolInvocation

_LONG_NAME = 'probe_' + 'x' * 80  # 列是 UniversalStr(64)


@pytest.fixture
def long_named_tool() -> Any:
    load_builtin_tools()

    @ai_tool(name=_LONG_NAME, description='探针', domain='system', perm=None)
    async def _probe() -> dict[str, Any]:  # ruff: ignore[unused-async]
        return {'ok': True}

    try:
        yield
    finally:
        _REGISTRY.pop(_LONG_NAME, None)


def test_failed_audit_does_not_poison_the_session(long_named_tool: Any) -> None:
    superuser = SimpleNamespace(id=1, username='admin', dept_id=None, is_superuser=True, is_staff=True, roles=[])

    async def _main() -> tuple[Any, Any, int]:
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                ctx = RunContext(user=superuser, conversation_id=1, db=db, provider=None)
                try:
                    first = await tool_dispatcher.dispatch(ToolCallRequest('c1', _LONG_NAME, {}), ctx)
                    after = await tool_dispatcher.dispatch(ToolCallRequest('c2', 'dept_list', {}), ctx)
                    audited = await db.scalar(
                        select(func.count())
                        .select_from(AiToolInvocation)
                        .where(AiToolInvocation.tool_name == 'dept_list')
                    )
                    return first, after, audited or 0
                finally:
                    await db.rollback()
        finally:
            await engine.dispose()

    first, after, audited = asyncio.run(_main())
    # 前置断言：这条审计确实写失败了，否则下面那句「后面还能用」什么都没证明
    assert first.kind == 'ok', first.payload
    assert after.kind == 'ok', f'审计写失败之后，同一会话里的下一个工具也坏了：{after.payload}'
    assert audited >= 1, '审计失败一次之后，后面的审计也写不进去了'
