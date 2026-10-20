"""变更类工具的守卫测试：预演 → 确认 → 执行。

真正会静默出错的几处：

- **变更类工具没有预演**：确认卡片上只剩「工具名 + 参数」，`dept_id: "2048…"` 对人什么都没说，
  「人点头」退化成走过场 —— 所以注册期就拒掉
- **预演就会失败的调用先弹了确认卡片**：人点了确认才报「同级重名」，而且令牌已经发出去了
- **预演 / 执行不在调用者的数据范围里跑**：受限用户通过 AI 改到了他在界面上根本看不见的部门，
  接口照样成功、审计照样记成功
- **改名时漏带原上级**：同级重名会按「顶级」去判，校验对象错了却不报错

部门工具那几条用真实测试库（不提交，结束回滚）+ 真实 Redis，不 mock service ——
要验证的恰恰是「预演和执行共用同一份业务规则」，mock 掉 service 就什么都没验。
"""

import asyncio
import uuid

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import select

from backend.app.admin.model import Dept, User
from backend.common.security.data_scope import _current_user
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import RedisCli
from backend.plugin.ai.core import dispatcher as dispatcher_module
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import _REGISTRY, ai_tool, load_builtin_tools


async def _noop_audit(*_args: Any, **_kwargs: Any) -> None:  # ruff: ignore[unused-async]
    """审计不是这里要测的；而且测试库未必升到了带 ai_tool_invocation 的版本"""
    return


def _user(*, perms: list[str], superuser: bool = False, fail_closed_scope: bool = False) -> Any:
    """`fail_closed_scope=True`：角色开了数据范围过滤却一条范围都没配 —— 什么部门都看不见"""
    menus = [SimpleNamespace(id=i, perms=p, status=1) for i, p in enumerate(perms)]
    role = SimpleNamespace(status=1, menus=menus, is_filter_scopes=fail_closed_scope, scopes=[])
    return SimpleNamespace(id=1, dept_id=None, is_superuser=superuser, is_staff=True, roles=[role])


@pytest.fixture(autouse=True)
def _patch_audit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tool_dispatcher, '_audit', _noop_audit)


def _run(monkeypatch: pytest.MonkeyPatch, scenario: Any) -> Any:
    """新事件循环 + 新 Redis 连接 + 新测试库引擎；会话**不提交**，结束回滚。

    ⚠️ 不能用模块级的 `redis_client` / `async_test_db_session` —— 它们绑在别的事件循环上
    （同 `test_auth.py: _clear_login_counters`、`test_prod_config.py` 踩过的坑）。
    """

    async def _main() -> Any:
        redis = RedisCli()
        monkeypatch.setattr(dispatcher_module, 'redis_client', redis)
        engine = create_database_async_engine(get_database_url(unittest=True))
        try:
            async with create_database_async_session(engine)() as db:
                try:
                    return await scenario(db)
                finally:
                    await db.rollback()
        finally:
            await engine.dispose()
            await redis.aclose()

    return asyncio.run(_main())


def _ctx(user: Any, db: Any) -> RunContext:
    return RunContext(user=user, conversation_id=1, db=db, provider=None)


async def _dispatch(ctx: RunContext, tool: str, /, *, pre_approved: bool = False, **arguments: Any) -> Any:
    call = ToolCallRequest(call_id=uuid.uuid4().hex, name=tool, arguments=arguments)
    return await tool_dispatcher.dispatch(call, ctx, pre_approved=pre_approved)


class TestRegistryRequiresPreview:
    def test_mutating_tool_without_preview_is_rejected(self) -> None:
        with pytest.raises(TypeError, match='preview'):

            @ai_tool(name='_no_preview', description='x', domain='system', mutating=True)
            async def _no_preview() -> None:  # ruff: ignore[unused-async]
                return

        assert '_no_preview' not in _REGISTRY


class TestPreviewGate:
    """预演是确认之前的闸：失败就不发令牌、不执行；成功才请人确认"""

    @pytest.fixture
    def probe(self) -> Iterator[dict[str, Any]]:
        seen: dict[str, Any] = {'executed': 0}

        async def _preview(ctx: RunContext, *, fail: bool = False) -> str:  # ruff: ignore[unused-async]
            seen['preview_user'] = _current_user.get()
            if fail:
                raise ValueError('预演发现冲突')
            return f'将为 {ctx.user.id} 做一件事'

        @ai_tool(name='_probe_write', description='探针', domain='system', mutating=True, preview=_preview)
        async def _probe_write(*, fail: bool = False) -> dict[str, Any]:  # ruff: ignore[unused-async]
            del fail  # 只是为了和 preview 同签名
            seen['executed'] += 1
            return {'ok': True}

        try:
            yield seen
        finally:
            _REGISTRY.pop('_probe_write', None)

    def test_failed_preview_blocks_before_confirm(self, monkeypatch: pytest.MonkeyPatch, probe: dict) -> None:
        user = _user(perms=[], superuser=True)

        async def scenario(db: Any) -> Any:
            return await _dispatch(_ctx(user, db), '_probe_write', fail=True)

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert outcome.confirm_token is None, '预演失败还发了确认令牌'
        assert '预演发现冲突' in outcome.payload, '失败原因要回给模型，让它告诉用户'
        assert probe['executed'] == 0

    def test_preview_text_reaches_confirm_and_runs_in_user_scope(
        self, monkeypatch: pytest.MonkeyPatch, probe: dict
    ) -> None:
        user = _user(perms=[], superuser=True)

        async def scenario(db: Any) -> Any:
            return await _dispatch(_ctx(user, db), '_probe_write')

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'confirm_required', outcome
        assert outcome.confirm_token
        assert outcome.preview == '将为 1 做一件事'
        assert probe['executed'] == 0, '没确认就执行了'
        assert probe['preview_user'] is user, '预演不在调用者的数据范围里跑 —— 受限用户会预演到范围外的数据'


class TestDeptWriteTools:
    @pytest.fixture(autouse=True)
    def _tools(self) -> None:
        load_builtin_tools()

    ADMIN = staticmethod(lambda: _user(perms=['sys:dept:add', 'sys:dept:edit', 'sys:dept:list'], superuser=True))

    @staticmethod
    async def _any_dept(db: Any) -> Dept:
        dept = (await db.execute(select(Dept).where(Dept.deleted == 0).limit(1))).scalars().first()
        assert dept is not None, '前置：测试库里要有部门（种子数据）'
        return dept

    def test_create_then_rename_round_trip(self, monkeypatch: pytest.MonkeyPatch) -> None:
        code = f'AI_{uuid.uuid4().hex[:8].upper()}'

        async def scenario(db: Any) -> dict[str, Any]:
            ctx = _ctx(self.ADMIN(), db)
            parent = await self._any_dept(db)
            args = {'name': 'AI 测试部', 'code': code, 'parent_id': str(parent.id)}

            staged = await _dispatch(ctx, 'dept_create', **args)
            not_yet = (await db.execute(select(Dept).where(Dept.code == code))).scalars().first()
            created = await _dispatch(ctx, 'dept_create', pre_approved=True, **args)
            await db.flush()  # 会话是 autoflush=False；生产里由 confirm_tool 的 commit 落地
            dept = (await db.execute(select(Dept).where(Dept.code == code))).scalars().one()

            renamed_stage = await _dispatch(ctx, 'dept_rename', dept_id=str(dept.id), new_name='AI 测试部（改）')
            renamed = await _dispatch(
                ctx, 'dept_rename', pre_approved=True, dept_id=str(dept.id), new_name='AI 测试部（改）'
            )
            await db.flush()
            await db.refresh(dept)
            # 结束会回滚，ORM 实例随之失效 —— 断言要用的值在会话里取出来
            return {
                'parent_name': parent.name, 'parent_id': parent.id, 'staged': staged, 'not_yet': not_yet,
                'created': created, 'renamed_stage': renamed_stage, 'renamed': renamed,
                'name': dept.name, 'dept_parent_id': dept.parent_id,
            }  # fmt: skip

        r = _run(monkeypatch, scenario)
        assert r['staged'].kind == 'confirm_required', r['staged']
        assert r['staged'].preview == f'将在「{r["parent_name"]}」下新建部门「AI 测试部」（编码 {code}）'
        assert r['not_yet'] is None, '预演阶段就把部门建出来了'
        assert r['created'].kind == 'ok', r['created']
        assert r['dept_parent_id'] == r['parent_id']

        assert r['renamed_stage'].kind == 'confirm_required', r['renamed_stage']
        assert r['renamed_stage'].preview == f'将把部门「AI 测试部」（编码 {code}）改名为「AI 测试部（改）」'
        assert r['renamed'].kind == 'ok', r['renamed']
        assert r['name'] == 'AI 测试部（改）'
        assert r['dept_parent_id'] == r['parent_id'], '改名把上级也动了'

    def test_duplicate_sibling_name_fails_in_preview(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """同级重名要在预演里就拦住，走的是 `dept_service.check_create` 那一份规则"""

        async def scenario(db: Any) -> tuple[Any, Any]:
            ctx = _ctx(self.ADMIN(), db)
            existing = await self._any_dept(db)
            parent_id = str(existing.parent_id) if existing.parent_id else None
            code = f'AI_{uuid.uuid4().hex[:8].upper()}'
            outcome = await _dispatch(ctx, 'dept_create', name=existing.name, code=code, parent_id=parent_id)
            return outcome, existing

        outcome, _ = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert outcome.confirm_token is None

    def test_rename_outside_data_scope_is_refused(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """🔴 有 `sys:dept:edit` 但数据范围看不见这个部门 —— 预演就该当它不存在。

        界面上他根本看不到这个部门（列表按同一个范围过滤），换成「让 AI 改」也不能改到。
        """
        scoped = _user(perms=['sys:dept:edit', 'sys:dept:list'], fail_closed_scope=True)

        async def scenario(db: Any) -> tuple[Any, Any, str]:
            dept = await self._any_dept(db)
            original = dept.name
            stage = await _dispatch(_ctx(scoped, db), 'dept_rename', dept_id=str(dept.id), new_name='越权改名')
            forced = await _dispatch(
                _ctx(scoped, db), 'dept_rename', pre_approved=True, dept_id=str(dept.id), new_name='越权改名'
            )
            await db.refresh(dept)
            return stage, forced, (original, dept.name)  # 都是 str，回滚后仍可用

        stage, forced, (before, after) = _run(monkeypatch, scenario)
        assert stage.kind == 'failed', f'范围外的部门进了确认流程：{stage}'
        assert stage.confirm_token is None
        assert forced.kind == 'failed', f'跳过确认直接执行（模拟伪造的 pre_approved）改到了范围外的部门：{forced}'
        assert after == before

    def test_rename_into_sibling_name_fails_in_preview(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """改名撞上**同级**兄弟要拦住。守的是 `_rename_param` 里显式带上原 `parent_id` 那一行：

        漏带的话 `check_update` 按「挪到顶级」去找同名兄弟，真正的兄弟查不到，
        预演放行、执行也放行 —— 同一个上级下出现两个同名部门，没有任何报错。
        """

        async def scenario(db: Any) -> Any:
            ctx = _ctx(self.ADMIN(), db)
            parent = await self._any_dept(db)
            codes = [f'AI_{uuid.uuid4().hex[:8].upper()}' for _ in range(2)]
            for name, code in zip(('AI 兄弟甲', 'AI 兄弟乙'), codes, strict=True):
                created = await _dispatch(
                    ctx, 'dept_create', pre_approved=True, name=name, code=code, parent_id=str(parent.id)
                )
                assert created.kind == 'ok', created
            await db.flush()
            second = (await db.execute(select(Dept).where(Dept.code == codes[1]))).scalars().one()
            return await _dispatch(ctx, 'dept_rename', dept_id=str(second.id), new_name='AI 兄弟甲')

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', f'改名撞上同级兄弟却进了确认流程：{outcome}'


class TestDeptLeader:
    """负责人：人说名字，库里存用户 ID。

    🔴 每条都要把建出来 / 改过的部门**读回来**断言 `leader_id` —— 上一次的 bug 恰恰是
    预演卡片写着「负责人：张三」、确认成功、而库里没有负责人（pydantic 静默丢了未知字段）。
    只断言预演文案和 `kind == 'ok'` 的测试，对那个 bug 是绿的。
    """

    @pytest.fixture(autouse=True)
    def _tools(self) -> None:
        load_builtin_tools()

    ADMIN = staticmethod(lambda: _user(perms=['sys:dept:add', 'sys:dept:edit', 'sys:dept:list'], superuser=True))

    @staticmethod
    async def _user_by_name(db: Any, username: str) -> User:
        user = (await db.execute(select(User).where(User.username == username))).scalars().one()
        return user

    @staticmethod
    async def _create(ctx: RunContext, db: Any, *, leader: str | None, pre_approved: bool) -> tuple[Any, str]:
        code = f'AI_{uuid.uuid4().hex[:8].upper()}'
        outcome = await _dispatch(
            ctx, 'dept_create', pre_approved=pre_approved, name=f'负责人测试{code}', code=code, leader=leader
        )
        return outcome, code

    @pytest.mark.parametrize('leader', ['张伟', 'zhangwei'], ids=['by-nickname', 'by-username'])
    def test_create_with_leader_is_really_saved(self, monkeypatch: pytest.MonkeyPatch, leader: str) -> None:
        async def scenario(db: Any) -> dict[str, Any]:
            ctx = _ctx(self.ADMIN(), db)
            zhangwei = await self._user_by_name(db, 'zhangwei')
            staged, _ = await self._create(ctx, db, leader=leader, pre_approved=False)
            done, code = await self._create(ctx, db, leader=leader, pre_approved=True)
            await db.flush()
            dept = (await db.execute(select(Dept).where(Dept.code == code))).scalars().one()
            return {'staged': staged, 'done': done, 'leader_id': dept.leader_id, 'expected': zhangwei.id}

        r = _run(monkeypatch, scenario)
        assert r['staged'].kind == 'confirm_required', r['staged']
        assert '负责人 张伟（zhangwei）' in r['staged'].preview
        assert r['done'].kind == 'ok', r['done']
        assert r['leader_id'] == r['expected'], '预演说设了负责人，库里却不是这个人'

    @pytest.mark.parametrize(
        ('setup', 'leader', 'expect'),
        [
            (None, '查无此人', '找不到负责人'),
            ('duplicate', '张伟', '对应多个用户'),
            ('disabled', 'zhangwei', '找不到负责人'),
        ],
        ids=['unknown', 'ambiguous', 'disabled-account'],
    )
    def test_unusable_leader_fails_in_preview(
        self, monkeypatch: pytest.MonkeyPatch, setup: str | None, leader: str, expect: str
    ) -> None:
        """找不到 / 重名 / 已停用，都要在弹确认卡片**之前**拦下 —— 重名尤其不能「挑一个」"""

        async def scenario(db: Any) -> Any:
            if setup == 'duplicate':
                (await self._user_by_name(db, 'lina')).nickname = '张伟'  # 回滚时还原
            elif setup == 'disabled':
                (await self._user_by_name(db, 'zhangwei')).status = 0
            await db.flush()
            outcome, _ = await self._create(_ctx(self.ADMIN(), db), db, leader=leader, pre_approved=False)
            return outcome

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert outcome.confirm_token is None
        assert expect in outcome.payload, outcome.payload
        if setup == 'duplicate':
            assert 'zhangwei' in outcome.payload and 'lina' in outcome.payload, '重名时要列出候选的用户名'

    def test_leader_outside_data_scope_is_invisible(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """有建部门的权限、但数据范围看不见那个人 —— 对工具来说这个人就不存在"""
        scoped = _user(perms=['sys:dept:add', 'sys:dept:list'], fail_closed_scope=True)

        async def scenario(db: Any) -> Any:
            outcome, _ = await self._create(_ctx(scoped, db), db, leader='zhangwei', pre_approved=False)
            return outcome

        outcome = _run(monkeypatch, scenario)
        assert outcome.kind == 'failed', outcome
        assert '找不到负责人' in outcome.payload

    def test_set_leader_round_trip(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario(db: Any) -> dict[str, Any]:
            ctx = _ctx(self.ADMIN(), db)
            created, code = await self._create(ctx, db, leader=None, pre_approved=True)
            assert created.kind == 'ok', created
            await db.flush()
            dept = (await db.execute(select(Dept).where(Dept.code == code))).scalars().one()
            before = dept.leader_id
            staged = await _dispatch(ctx, 'dept_set_leader', dept_id=str(dept.id), leader='李娜')
            done = await _dispatch(ctx, 'dept_set_leader', pre_approved=True, dept_id=str(dept.id), leader='李娜')
            await db.flush()
            await db.refresh(dept)
            again = await _dispatch(ctx, 'dept_set_leader', dept_id=str(dept.id), leader='lina')
            lina = await self._user_by_name(db, 'lina')
            return {
                'before': before, 'staged': staged, 'done': done, 'after': dept.leader_id,
                'expected': lina.id, 'name': dept.name, 'again': again,
            }  # fmt: skip

        r = _run(monkeypatch, scenario)
        assert r['before'] is None
        assert r['staged'].kind == 'confirm_required', r['staged']
        assert r['staged'].preview.endswith('的负责人从「未设置」改为 李娜（lina）'), r['staged'].preview
        assert r['done'].kind == 'ok', r['done']
        assert r['after'] == r['expected'], '确认之后库里的负责人不是李娜'
        assert r['again'].kind == 'failed' and '不需要改' in r['again'].payload, r['again']
