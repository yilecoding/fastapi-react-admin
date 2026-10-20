"""每个只读工具都在真实测试库上真跑一遍。

🔴 **工具调的是 service 的函数，而 service 的签名会被别的 PR 改掉。** 实测踩过：
#108（审批流）把 `DeptService.get_tree()` 的 `leader` 参数删了，#105（AI 助手）在它之后
合并，`dept_list` 还在传 `leader=None` —— 两个 PR 各自 CI 全绿，合起来 `dept_list` 每次都
`unexpected keyword argument`。用户问「有哪些部门」，模型拿到一句参数错误，
在 5 轮上限里反复重试，最后报「请把问题拆小一些」，看起来像模型笨，不像代码坏了。

这里不断言返回内容（那是各个 service 自己的测试），只断言「能跑通」——
签名漂移、字段改名、import 断掉都会在这一层红。
"""

import asyncio

from types import SimpleNamespace
from typing import Any

import pytest

from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import _REGISTRY, load_builtin_tools

# 要连外网的工具不在这里跑（CI 没有外网，红了也说明不了代码的问题）
_NEEDS_NETWORK = {'weather'}

load_builtin_tools()
_READ_TOOLS = sorted(s.name for s in _REGISTRY.values() if not s.mutating and s.domain not in _NEEDS_NETWORK)


async def _noop_audit(*_args: Any, **_kwargs: Any) -> None:  # ruff: ignore[unused-async]
    """审计不是这里要测的"""
    return


def _minimal_args(name: str) -> dict[str, Any]:
    """只填必填参数。不填可选参数是刻意的：可选参数的默认值本身也要能跑通"""
    schema = _REGISTRY[name].parameters
    samples = {'string': 'x', 'integer': 1, 'number': 1, 'boolean': False}
    return {key: samples[schema['properties'][key].get('type', 'string')] for key in schema.get('required', [])}


def test_read_tools_are_found() -> None:
    # 先断言「有」：工具没加载上时下面的参数化是空的，pytest 照样绿
    assert len(_READ_TOOLS) >= 8, _READ_TOOLS


@pytest.mark.parametrize('name', _READ_TOOLS)
def test_read_tool_runs(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setattr(tool_dispatcher, '_audit', _noop_audit)
    # 字段照 JWT 中间件放进 request.user 的那份（GetUserInfoWithRelationDetail）里工具会读到的
    superuser = SimpleNamespace(id=1, username='admin', dept_id=None, is_superuser=True, is_staff=True, roles=[])

    async def _main() -> Any:
        # 独立引擎：共享的 async_test_db_session 绑在 TestClient 的事件循环上
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                ctx = RunContext(user=superuser, conversation_id=1, db=db, provider=None)
                try:
                    return await tool_dispatcher.dispatch(
                        ToolCallRequest(call_id='smoke', name=name, arguments=_minimal_args(name)), ctx
                    )
                finally:
                    await db.rollback()
        finally:
            await engine.dispose()

    outcome = asyncio.run(_main())
    assert outcome.kind == 'ok', f'{name} 跑不通：{outcome.payload}'
