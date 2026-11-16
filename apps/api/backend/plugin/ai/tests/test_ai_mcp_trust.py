"""MCP 网关的人工确认与身份边界（#314）。

两条单看都要非默认配置，叠在一起就是「外部系统以超管身份直接写」：

- `AI_CONFIRM_MUTATING_TOOLS = false` 原来同时放开了 MCP：替别人发起的写操作不经本人确认直接执行
- 凭据管理只校验「用户名存在」，不校验发放者自己够不够格：非超管能发 `allow_superuser` / `act_as=["*"]` 的凭据，
  也能给超管发的凭据换令牌、拿到明文

会话一律回滚（建 / 换的凭据和部门都不落库）。
"""

import asyncio
import json
import uuid

from types import SimpleNamespace
from typing import Any

import pytest

from sqlalchemy import select

from backend.app.admin.model import Dept
from backend.common.exception import errors
from backend.core.conf import settings
from backend.database.db import create_database_async_engine, create_database_async_session, get_database_url
from backend.database.redis import RedisCli
from backend.plugin.ai.core import dispatcher as dispatcher_module
from backend.plugin.ai.core.dispatcher import tool_dispatcher
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest
from backend.plugin.ai.core.registry import load_builtin_tools
from backend.plugin.ai.model import AiMcpClient
from backend.plugin.ai.schema.mcp_client import CreateAiMcpClientParam, UpdateAiMcpClientParam
from backend.plugin.ai.service.mcp_client_service import ai_mcp_client_service


async def _noop_audit(*_args: Any, **_kwargs: Any) -> None:  # ruff: ignore[unused-async]
    return


def _user(*, superuser: bool, fail_closed_scope: bool = False) -> Any:
    """`fail_closed_scope=True`：角色开了数据范围过滤却一条范围都没配 —— 谁都看不见"""
    perms = ['sys:dept:add', 'ai:mcp:add', 'ai:mcp:edit']
    menus = [SimpleNamespace(id=i, perms=p, status=1) for i, p in enumerate(perms)]
    role = SimpleNamespace(status=1, menus=menus, is_filter_scopes=fail_closed_scope, scopes=[])
    return SimpleNamespace(id=1, dept_id=None, is_superuser=superuser, is_staff=True, roles=[role])


def _run(monkeypatch: pytest.MonkeyPatch, scenario: Any) -> Any:
    """新事件循环 + 新 Redis + 新测试库引擎；会话不提交，结束回滚（同 `test_ai_write_tools.py`）"""

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


class TestConfirmSwitchOnlyCoversThePersonPresent:
    _CODE = 'MCP_TRUST_PYTEST'

    @pytest.fixture(autouse=True)
    def _setup(self, monkeypatch: pytest.MonkeyPatch) -> None:
        load_builtin_tools()
        monkeypatch.setattr(tool_dispatcher, '_audit', _noop_audit)
        monkeypatch.setattr(settings, 'AI_CONFIRM_MUTATING_TOOLS', False)

    def _create_dept(self, monkeypatch: pytest.MonkeyPatch, *, user_present: bool) -> tuple[str, bool]:
        async def scenario(db: Any) -> tuple[str, bool]:
            ctx = RunContext(user=_user(superuser=True), conversation_id=1, db=db, provider=None)
            ctx.user_present = user_present
            call = ToolCallRequest(
                call_id=uuid.uuid4().hex, name='dept_create', arguments={'name': '确认开关测试', 'code': self._CODE}
            )
            outcome = await tool_dispatcher.dispatch(call, ctx)
            await db.flush()
            created = (await db.execute(select(Dept.id).where(Dept.code == self._CODE))).first() is not None
            return outcome.kind, created

        return _run(monkeypatch, scenario)

    def test_someone_acting_for_the_user_still_needs_confirmation(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """MCP 那种：身份是外部系统声明的，开关关了也只预演、发确认令牌"""
        assert self._create_dept(monkeypatch, user_present=False) == ('confirm_required', False)

    def test_the_switch_still_works_for_the_person_in_the_web_chat(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """开关本来的用途不能被这次修复一起拿掉"""
        assert self._create_dept(monkeypatch, user_present=True) == ('ok', True)

    def test_new_entries_are_fail_closed(self) -> None:
        """以后加入口忘了设 `user_present`：照样要确认，而不是悄悄放开"""
        assert RunContext(user=None, conversation_id=1, db=None, provider=None).user_present is False  # type: ignore[arg-type]


class TestOnlyGrantWhatYouHave:
    @staticmethod
    def _param(cls: type, **cfg: Any) -> Any:
        return cls(**{
            'client_id': f'pytest-trust-{uuid.uuid4().hex[:8]}',
            'name': '测试系统',
            'act_as': ['test'],
            **cfg,
        })

    @pytest.mark.parametrize(
        'cfg',
        [{'allow_superuser': True}, {'act_as': ['*']}],
        ids=['allow_superuser', 'act_as_star'],
    )
    def test_non_superuser_cannot_create_or_update_to_superuser_reach(
        self, monkeypatch: pytest.MonkeyPatch, cfg: dict[str, Any]
    ) -> None:
        async def scenario(db: Any) -> None:
            operator = _user(superuser=False)
            with pytest.raises(errors.ForbiddenError):
                await ai_mcp_client_service.create(
                    db=db, obj=self._param(CreateAiMcpClientParam, **cfg), operator=operator
                )
            # 超管先发一份普通的，非超管改不成上面那样
            admin = _user(superuser=True)
            issued = await ai_mcp_client_service.create(db=db, obj=self._param(CreateAiMcpClientParam), operator=admin)
            with pytest.raises(errors.ForbiddenError):
                await ai_mcp_client_service.update(
                    db=db, pk=issued.id, obj=self._param(UpdateAiMcpClientParam, **cfg), operator=operator
                )

        _run(monkeypatch, scenario)

    def test_superuser_can(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def scenario(db: Any) -> None:
            obj = self._param(CreateAiMcpClientParam, allow_superuser=True, act_as=['*'])
            issued = await ai_mcp_client_service.create(db=db, obj=obj, operator=_user(superuser=True))
            assert issued.mcp_token

        _run(monkeypatch, scenario)

    def test_named_users_must_be_in_the_operators_scope(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """看不见的人不能被他发凭据代表；报错和「不存在」同一句，不当探针"""

        async def scenario(db: Any) -> tuple[str, str]:
            blind = _user(superuser=False, fail_closed_scope=True)
            messages = []
            for act_as in (['admin'], ['no-such-user-pytest']):
                with pytest.raises(errors.RequestError) as e:
                    await ai_mcp_client_service.create(
                        db=db, obj=self._param(CreateAiMcpClientParam, act_as=act_as), operator=blind
                    )
                messages.append(e.value.msg.split('：')[0])
            # 范围不受限的非超管照常能发
            await ai_mcp_client_service.create(
                db=db, obj=self._param(CreateAiMcpClientParam, act_as=['admin']), operator=_user(superuser=False)
            )
            return messages[0], messages[1]

        in_scope_missing, nonexistent = _run(monkeypatch, scenario)
        assert in_scope_missing == nonexistent

    def test_non_superuser_cannot_delete_a_superuser_credential(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """改不了就也删不掉：删了外部系统那条集成当场 401"""

        async def scenario(db: Any) -> None:
            obj = self._param(CreateAiMcpClientParam, allow_superuser=True, act_as=['admin'])
            issued = await ai_mcp_client_service.create(db=db, obj=obj, operator=_user(superuser=True))
            with pytest.raises(errors.ForbiddenError):
                await ai_mcp_client_service.delete(db=db, pk=issued.id, operator=_user(superuser=False))
            assert (await db.get(AiMcpClient, issued.id)).deleted == 0

        _run(monkeypatch, scenario)

    def test_non_superuser_cannot_rotate_a_superuser_credential(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """换令牌 = 拿到一把能代表超管的明文令牌"""

        async def scenario(db: Any) -> None:
            obj = self._param(CreateAiMcpClientParam, allow_superuser=True, act_as=['admin'])
            issued = await ai_mcp_client_service.create(db=db, obj=obj, operator=_user(superuser=True))
            before = (await db.get(AiMcpClient, issued.id)).token_sha256
            with pytest.raises(errors.ForbiddenError):
                await ai_mcp_client_service.rotate(db=db, pk=issued.id, operator=_user(superuser=False))
            assert (await db.get(AiMcpClient, issued.id)).token_sha256 == before
            # 普通的那份照常能换
            plain = await ai_mcp_client_service.create(
                db=db, obj=self._param(CreateAiMcpClientParam), operator=_user(superuser=True)
            )
            assert (await ai_mcp_client_service.rotate(db=db, pk=plain.id, operator=_user(superuser=False))).mcp_token
            assert json.loads((await db.get(AiMcpClient, plain.id)).act_as) == ['test']

        _run(monkeypatch, scenario)
