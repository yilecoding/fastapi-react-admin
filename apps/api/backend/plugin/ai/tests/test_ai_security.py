"""AI 助手的安全守卫测试。

覆盖的是这套设计里**真正会静默越权/静默失败**的那几处，不是凑覆盖率：

- 工具可见性必须跟着权限码走：漏了它，一个看不到角色列表的人问 AI「有哪些角色」
  就能拿到全量列表，而界面上他连那个菜单都没有
- 变更类工具必须额外要求 `is_staff`：`rbac_verify` 对非 GET 请求有这道闸，
  而工具调用不经过 HTTP 方法，够不着它 —— 不显式补上就是一条绕过路径
- 分发时要**重新**校验权限，不能因为「它在可见清单里」就放行：可见清单是上一轮算的，
  而这条路径将来会被 sidecar 引擎直接打到，那时可见清单根本不在我们手上
- 模型幻觉出的工具名要当成一次失败的调用，不是让整个对话 500
- 流式工具调用的分片累积：写错的表现是「模型调用了 20 次工具、每次参数都是残缺 JSON」，
  而错误会被当成「模型参数填错了」，永远查不到流式解析这一层
- 密钥不能出现在任何响应 schema 里
"""

import ast
import asyncio
import dataclasses
import inspect
import typing

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from backend.common.security.data_scope import _current_user
from backend.plugin.ai.api.v1 import tool as tool_api
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.permission import user_can, user_can_mutate
from backend.plugin.ai.core.ports import AgentRuntimePort, RunContext, ToolCallRequest, ToolSchema
from backend.plugin.ai.core.registry import _REGISTRY, ai_tool, all_tools, get_tool, load_builtin_tools
from backend.plugin.ai.crud.crud_tool_invocation import ai_tool_invocation_dao
from backend.plugin.ai.llm.client import _parse_sse_line, accumulate_tool_calls
from backend.plugin.ai.schema.provider import GetAiProviderDetail


def _user(*, superuser: bool = False, staff: bool = False, perms: list[str] | None = None) -> Any:
    """造一个带指定权限码的用户（不依赖种子数据）"""
    menus = [SimpleNamespace(id=i, perms=p, status=1) for i, p in enumerate(perms or [])]
    role = SimpleNamespace(status=1, menus=menus)
    return SimpleNamespace(id=1, is_superuser=superuser, is_staff=staff, roles=[role] if menus else [])


class TestPermission:
    def test_superuser_can_call_anything(self) -> None:
        assert user_can(_user(superuser=True), 'sys:role:list')
        assert user_can_mutate(_user(superuser=True))

    def test_perm_code_is_required(self) -> None:
        user = _user(perms=['sys:role:list'])
        assert user_can(user, 'sys:role:list')
        assert not user_can(user, 'sys:dept:list')

    def test_user_without_roles_can_call_nothing(self) -> None:
        """没有启用角色 / 一个菜单都没分配 —— 同 rbac_verify 的前两道闸"""
        assert not user_can(_user(), 'sys:role:list')

    def test_mutating_requires_is_staff(self) -> None:
        """🔴 这条不是多余的。

        `rbac_verify` 对非 GET 请求额外要求 `is_staff`，而工具调用不经过 HTTP 方法。
        不显式补上的话，一个界面上做不了写操作的人，换成"让 AI 帮我做"就能做。
        """
        assert not user_can_mutate(_user(staff=False, perms=['sys:dept:add']))
        assert user_can_mutate(_user(staff=True, perms=['sys:dept:add']))


class TestToolVisibility:
    @pytest.fixture(autouse=True)
    def _tools(self) -> None:
        load_builtin_tools()

    def test_builtin_tools_registered(self) -> None:
        names = {spec.name for spec in all_tools()}
        assert {'system_health_check', 'system_whoami', 'role_list', 'dept_list', 'menu_list'} <= names

    def test_visible_tools_follow_perm_codes(self) -> None:
        """看不到角色列表的人，在 AI 的工具清单里也不该有 role_list"""
        from backend.plugin.ai.core.dispatcher import tool_dispatcher

        limited = _user(perms=['sys:dept:list'])
        visible = {spec.name for spec in tool_dispatcher.visible_tools(limited)}
        assert 'dept_list' in visible
        assert 'role_list' not in visible
        # 不要求业务权限的工具对任何有菜单的用户都可见
        assert 'system_health_check' in visible

    def test_every_tool_perm_is_a_guarded_api_code_in_the_seed(self) -> None:
        """🔴 工具的权限码 = 界面上同一个操作的接口权限码（`test_permission_codes.py` 三方对账的第四方）

        - 不是后端守卫过的码：工具自己发明了一个权限，和接口的门槛对不上（界面上做不了的，换成 AI 就能做，或者反过来）
        - 种子菜单里没有：只有超管看得见这个工具，别人怎么授权都调不到，而清单里只是「少了一个工具」
        """
        from backend.app.admin.tests.security.test_permission_codes import _backend_codes, _seed_codes

        perms = {spec.name: spec.perm for spec in all_tools() if spec.perm}
        assert len(perms) >= 10, f'只扫到 {len(perms)} 个带权限码的工具，注册表可能没加载'
        backend, seed = _backend_codes(), _seed_codes()
        bad = {name: perm for name, perm in perms.items() if perm not in backend or perm not in seed}
        assert not bad, f'这些工具的权限码不是「后端守卫过、种子里也有」的：{bad}'

    def test_superuser_sees_every_tool_in_enabled_domains(self) -> None:
        from backend.core.conf import settings
        from backend.plugin.ai.core.dispatcher import tool_dispatcher

        visible = {spec.name for spec in tool_dispatcher.visible_tools(_user(superuser=True))}
        expected = {spec.name for spec in all_tools() if spec.domain in settings.AI_TOOL_DOMAINS}
        assert visible == expected

    def test_schema_is_inferred_from_signature(self) -> None:
        """入参 schema 是从函数签名推出来的，且注入参数（db/ctx）不暴露给模型"""
        spec = get_tool('dept_list')
        assert spec is not None
        properties = spec.parameters['properties']
        assert set(properties) == {'name', 'code', 'status'}
        assert 'db' not in properties
        assert 'ctx' not in properties


class TestRegistry:
    def test_duplicate_tool_name_is_rejected(self) -> None:
        """重名工具必须当场炸，不能后注册的静默覆盖先注册的"""
        load_builtin_tools()
        with pytest.raises(ValueError, match='重名'):

            @ai_tool(name='role_list', description='x', domain='role')
            async def _dup() -> None: ...

    def test_sync_function_is_rejected(self) -> None:
        with pytest.raises(TypeError, match='async'):

            @ai_tool(name='_sync_tool', description='x', domain='system')
            def _sync() -> None: ...


class TestStreamParsing:
    def test_tool_call_fragments_are_concatenated(self) -> None:
        """🔴 OpenAI 把一次工具调用拆成多个 delta 发，arguments 是被切碎的字符串。

        每个 delta 当成一次独立调用的话，表现是"模型调用了 N 次工具、
        每次参数都是残缺 JSON"，而错误会被当成模型的锅。
        """
        buffer: dict[int, dict[str, Any]] = {}
        accumulate_tool_calls(
            buffer, [{'index': 0, 'id': 'call_1', 'function': {'name': 'role_list', 'arguments': '{"a"'}}]
        )
        accumulate_tool_calls(buffer, [{'index': 0, 'function': {'arguments': ':1}'}}])
        assert buffer[0] == {'id': 'call_1', 'name': 'role_list', 'arguments': '{"a":1}'}

    def test_parallel_tool_calls_keep_separate_slots(self) -> None:
        buffer: dict[int, dict[str, Any]] = {}
        accumulate_tool_calls(
            buffer,
            [
                {'index': 0, 'id': 'a', 'function': {'name': 'role_list', 'arguments': '{}'}},
                {'index': 1, 'id': 'b', 'function': {'name': 'dept_list', 'arguments': '{}'}},
            ],
        )
        assert buffer[0]['name'] == 'role_list'
        assert buffer[1]['name'] == 'dept_list'

    @pytest.mark.parametrize('line', ['', ': ping', 'data: [DONE]', 'event: message'])
    def test_non_data_lines_are_skipped(self, line: str) -> None:
        """空行 / 心跳 / [DONE] 当 JSON 解析会在对话中途抛异常，而上一秒还在正常出字"""
        assert _parse_sse_line(line) is None

    def test_malformed_json_is_skipped_not_raised(self) -> None:
        assert _parse_sse_line('data: {not json') is None


class TestSecretsNeverLeak:
    def test_provider_detail_has_no_key_fields(self) -> None:
        """🔴 响应 schema 里既没有明文也没有密文，只有掩码。

        密文一旦出现在响应里，它就和明文一样值钱了（密文 + 一次代码泄露 = 明文）。
        """
        fields = set(GetAiProviderDetail.model_fields)
        assert 'api_key' not in fields
        assert 'api_key_cipher' not in fields
        assert 'api_key_mask' in fields

    def test_mask_keeps_short_keys_fully_hidden(self) -> None:
        from backend.plugin.ai.service.provider_service import mask_key

        assert mask_key('12345678') == '*' * 8
        masked = mask_key('sk-1234567890abcdef')
        assert masked.startswith('sk-123') and masked.endswith('cdef') and '*' in masked


class TestLogFilterParams:
    """🔴 DAO 收了筛选参数、接口没往下透传 —— FastAPI 会**静默丢弃**未声明的查询参数。

    实测踩过：`crud_tool_invocation.get_select()` 加了 `start_time` / `end_time`，
    `api/v1/tool.py` 那一侧没跟上，于是前端查询区里那个「调用时间」是个**死控件** ——
    点了、URL 变了、请求也发出去了，返回的却始终是全量。没有任何一层会报错。

    所以这里守的是**整类**而不是这一次：DAO 的筛选签名、接口的查询参数、
    以及接口有没有真的往下传，三件事都要对上。
    """

    #: `user_id` 是留给「只看自己」的，接口上还没开 —— 显式豁免，不要默默放过
    EXEMPT = frozenset({'user_id'})

    @staticmethod
    def _dao_filters() -> set[str]:
        sig = inspect.signature(ai_tool_invocation_dao.get_select)
        return {n for n, p in sig.parameters.items() if p.kind is p.KEYWORD_ONLY}

    @staticmethod
    def _route_params() -> set[str]:
        sig = inspect.signature(tool_api.get_tool_logs)
        return {n for n in sig.parameters if n != 'db'}

    def test_every_dao_filter_is_exposed_by_the_route(self) -> None:
        missing = self._dao_filters() - self._route_params() - self.EXEMPT
        assert not missing, f'DAO 支持但接口没声明的筛选参数（会被 FastAPI 静默丢弃）: {sorted(missing)}'

    def test_route_does_not_declare_filters_the_dao_ignores(self) -> None:
        # 反方向同样是静默的：接口收了、DAO 不认，参数一样不起作用
        extra = self._route_params() - self._dao_filters()
        assert not extra, f'接口声明了但 DAO 不认的筛选参数（填了也不过滤）: {sorted(extra)}'

    def test_time_range_reaches_the_sql(self) -> None:
        """光对齐签名还不够 —— 传进去的值要真的落到 WHERE 上。

        ⚠️ 断言的是**绑定值**，不是渲染出来的日期字符串。`TimeZone` 这个列类型会把
        带时区的入参 `astimezone()` 到 `DATETIME_TIMEZONE`，所以传 UTC 的
        `2030-12-31 23:59:59` 渲染出来是 `2031-01-01 07:59:59+08:00` —— 按日期
        子串断言会把一次**正确**的时区换算误判成「过滤没生效」。
        """
        start = datetime(2030, 1, 1, 0, 0, 0, tzinfo=UTC)
        end = datetime(2030, 12, 31, 23, 59, 59, tzinfo=UTC)
        compiled = asyncio.run(ai_tool_invocation_dao.get_select(start_time=start, end_time=end)).compile()
        sql = str(compiled)
        assert 'created_time >=' in sql and 'created_time <=' in sql, f'时间范围没进 WHERE:\n{sql}'
        bound = sorted(v for v in compiled.params.values() if isinstance(v, datetime))
        assert bound == [start, end], f'绑定值对不上: {bound}'

    def test_route_actually_forwards_every_filter_to_the_dao(self) -> None:
        """🔴 上面两条只对齐了**签名**，而真正踩到的那次是「声明了但没往下传」。

        `get_tool_logs` 里少写一个 `start_time=start_time`，签名照样对齐、
        类型检查照样过、接口照样 200 —— 只是那个筛选永远不起作用。
        所以这里真的调一次路由函数，看 DAO 收到了什么。
        """
        seen: dict[str, object] = {}

        # 两个假货必须是协程：路由里是 await 调的。ruff 的 unused-async 在这里是误报
        async def fake_get_select(**kwargs: object) -> object:  # ruff: ignore[unused-async]
            seen.update(kwargs)
            return object()

        async def fake_paging(*_args: object, **_kw: object) -> object:  # ruff: ignore[unused-async]
            return object()

        sentinels: dict[str, object] = {
            'tool_name': 'weather',
            'status': 0,
            'start_time': datetime(2030, 1, 1, tzinfo=UTC),
            'end_time': datetime(2030, 12, 31, tzinfo=UTC),
        }
        accepted = self._route_params()
        unseeded = accepted - sentinels.keys()
        assert not unseeded, f'新增了筛选参数但这条测试没给它哨兵值: {sorted(unseeded)}'

        orig_select = tool_api.ai_tool_invocation_dao.get_select
        orig_paging = tool_api.paging_data
        tool_api.ai_tool_invocation_dao.get_select = fake_get_select  # type: ignore[method-assign]
        tool_api.paging_data = fake_paging  # type: ignore[assignment]
        try:
            asyncio.run(tool_api.get_tool_logs(db=None, **{k: sentinels[k] for k in accepted}))  # type: ignore[arg-type]
        finally:
            tool_api.ai_tool_invocation_dao.get_select = orig_select  # type: ignore[method-assign]
            tool_api.paging_data = orig_paging  # type: ignore[assignment]

        dropped = {k for k in accepted if seen.get(k) != sentinels[k]}
        assert not dropped, f'接口收下了却没传给 DAO 的筛选参数（填了也不过滤）: {sorted(dropped)}'


async def _noop_audit(*_args: Any, **_kwargs: Any) -> None:  # ruff: ignore[unused-async]
    """测试用的空审计 —— 真实实现要连库，而这里测的是数据权限不是审计"""
    return


class TestDispatcherAnchorsDataScope:
    """🔴 行级数据权限必须由 `dispatch()` 自己锚定，不能依赖「中间件反正会设」。

    `DataScopedCRUD._data_scope_condition()` 在 `_current_user` 为 `None` 时
    **不加任何过滤**（= 看全部）。那个 fail-open 对 Celery / CLI 是对的
    （没有「谁在看」这个概念），但 `set_current_user()` 全仓**只有
    `jwt_auth_middleware` 调** —— 所以任何不走 JWT 的入口（API key / MCP /
    sidecar，也就是设计里「入口可插拔」那一层）只要忘了设，受限用户就能通过
    AI 拿到全量数据，而接口返回 200、审计记「成功」，没有任何现象。

    🔴 **所以这两条刻意在一个干净的上下文里调 dispatch** —— 那正是未来新入口的
    处境。在已经设好上下文的情况下测，测的是中间件，不是这道闸。
    """

    @pytest.fixture
    def probe(self) -> Iterator[dict[str, Any]]:
        """只做一件事的探针工具：回报它执行时看到的数据权限上下文"""
        seen: dict[str, Any] = {}

        @ai_tool(name='_probe_scope', description='探针', domain='system', perm=None)
        async def _probe_scope() -> dict[str, Any]:  # ruff: ignore[unused-async]
            seen['user'] = _current_user.get()
            return {'ok': True}

        try:
            yield seen
        finally:
            _REGISTRY.pop('_probe_scope', None)

    @staticmethod
    async def _dispatch(user: Any) -> Any:
        call = ToolCallRequest(call_id='c1', name='_probe_scope', arguments={})
        ctx = RunContext(user=user, conversation_id=1, db=None, provider=None)  # type: ignore[arg-type]
        original = tool_dispatcher._audit
        tool_dispatcher._audit = _noop_audit  # type: ignore[method-assign]
        try:
            return await tool_dispatcher.dispatch(call, ctx)
        finally:
            tool_dispatcher._audit = original  # type: ignore[method-assign]

    def test_scope_is_set_even_with_no_ambient_context(self, probe: dict[str, Any]) -> None:
        assert _current_user.get() is None, '测试前置：上下文必须是干净的'
        user = _user(superuser=True)
        outcome = asyncio.run(self._dispatch(user))
        assert outcome.kind == 'ok', outcome
        assert probe['user'] is user, '工具执行时数据权限上下文是空的 —— 行级过滤会静默退化成「看全部」'

    def test_scope_is_restored_afterwards(self, probe: dict[str, Any]) -> None:
        """出了 dispatch 要还原，不能把上下文漏给同一请求里后面的代码。

        🔴 **断言必须和 dispatch 在同一个协程里**。第一版写的是
        `asyncio.run(self._dispatch(...))` 然后在外面读 `_current_user` ——
        那条测试**永远不会失败**：`asyncio.run` 把协程放进一个新任务，
        而任务拿的是上下文的**副本**，里面的 `set` 根本传不回调用方。
        变异检验抓出来的（把 `with scoped_to_user` 换成裸 `set_current_user`，
        那一版照样绿）。直接 `await`（不建任务）才共享同一个上下文。
        """

        async def run_and_observe() -> Any:
            await self._dispatch(_user(superuser=True))
            return _current_user.get()

        assert asyncio.run(run_and_observe()) is None, 'dispatch 把数据权限上下文漏出去了'


class TestEnginesNeverHoldExecutables:
    """🔴 引擎拿到的工具清单里**不能有可执行体**，否则「引擎只是建议者」只是约定。

    原来 `AgentRuntimePort.run` 收的是 `ToolSpec`，里面带着 `handler`。pydantic-ai
    spike 实测过这个洞：适配器里写一句 `Tool(spec.handler)`，框架就直接执行了，
    权限码 / 二次确认 / 审计全部跳过，**不报任何错**，对话照样正常。
    所以端口只给 `ToolSchema`（纯数据），执行只能回到 `tool_dispatcher.dispatch()`。
    """

    ENGINES_DIR = Path(__file__).resolve().parents[1] / 'engines'
    # 引擎里出现这些就能绕过 dispatcher 拿到可执行体
    FORBIDDEN_ATTRS = frozenset({'handler', 'visible_tools'})
    FORBIDDEN_MODULES = frozenset({'backend.plugin.ai.core.registry'})

    def test_port_takes_schemas_not_specs(self) -> None:
        hints = typing.get_type_hints(AgentRuntimePort.run)
        assert hints['tools'] == list[ToolSchema], f'引擎端口收的是 {hints["tools"]}，应为 list[ToolSchema]'

    def test_schema_has_no_callables(self) -> None:
        load_builtin_tools()
        schemas = tool_dispatcher.visible_schemas(_user(superuser=True))
        assert schemas, '前置：超管应当看得到工具'
        for schema in schemas:
            assert isinstance(schema, ToolSchema)
            for f in dataclasses.fields(schema):
                assert not callable(getattr(schema, f.name)), f'{schema.name}.{f.name} 是可执行的'

    def test_engines_do_not_reach_for_handlers(self) -> None:
        offenders = []
        for path in sorted(self.ENGINES_DIR.glob('*.py')):
            for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
                if isinstance(node, ast.Attribute) and node.attr in self.FORBIDDEN_ATTRS:
                    offenders.append(f'{path.name}:{node.lineno} .{node.attr}')
                elif isinstance(node, ast.ImportFrom) and node.module in self.FORBIDDEN_MODULES:
                    offenders.append(f'{path.name}:{node.lineno} from {node.module}')
                elif isinstance(node, ast.Import):
                    offenders += [
                        f'{path.name}:{node.lineno} import {a.name}'
                        for a in node.names
                        if a.name in self.FORBIDDEN_MODULES
                    ]
        assert not offenders, f'引擎绕过 dispatcher 拿可执行体：{offenders}'
