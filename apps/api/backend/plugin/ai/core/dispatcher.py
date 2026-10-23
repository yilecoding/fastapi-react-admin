"""ToolDispatcher —— 🔴 **整个设计里唯一不可插拔的那一层。**

引擎（进程内循环 / Node sidecar 里的 pi / 将来任何东西）对系统来说都是**不受信任的
建议者**：它只能提议调用某个工具，能不能真的落地由这里说了算。四道闸：

1. 权限码过滤——复用 `rbac_verify` 的判据（见 `core/permission.py`）
2. 数据范围继承——工具走 service 层，`jwt_auth_middleware` 已把当前用户写进
   `data_scope` 的 ContextVar，所以**什么都不用做就是对的**；反过来，
   任何地方图省事调 `bypass_data_scope()` 就会让受限用户通过 AI 看到全量数据
3. 二次确认——变更类工具先出预览 + 一次性令牌，用户点头才执行
4. 审计落库——**包括被拒绝的调用**

**为什么这层必须焊死在 Python 侧**：安全逻辑一旦下沉进引擎适配器，就会变成
"每接一个引擎写一遍"，而那正是 `common/security/AGENTS.md` 里反复出现的失败模式
（两套相似但独立的东西必然漂移），且漂移的表现是静默越权。
"""

import inspect
import json
import time
import uuid

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal

from backend.common.log import log
from backend.common.security.data_scope import scoped_to_user
from backend.core.conf import settings
from backend.database.redis import redis_client
from backend.plugin.ai.core.permission import user_can, user_can_mutate
from backend.plugin.ai.core.ports import RunContext, ToolCallRequest, ToolSchema, ToolSpec
from backend.plugin.ai.core.registry import get_tool, tools_in_domains
from backend.plugin.ai.enums import ToolInvocationStatus

# 结果摘要落库/回给模型时的长度上限。工具可能返回几百行数据，
# 原样塞回对话历史会把上下文撑爆（而且下一轮还要再发一遍）。
_RESULT_MAX_CHARS = 4000


@dataclass(slots=True)
class DispatchOutcome:
    """一次分发的结果"""

    kind: Literal['ok', 'denied', 'failed', 'confirm_required']
    #  回给**模型**的内容（会进对话历史）
    payload: str
    # 回给**界面**的摘要（给人看）
    summary: str
    confirm_token: str | None = None
    preview: str | None = None
    perm: str | None = None
    duration_ms: int | None = None


def _redact(value: Any, _depth: int = 0) -> Any:
    """按 `OPERA_LOG_REDACT_KEYS` 递归打码。

    刻意复用操作日志那份**同一个配置**而不是另列一份：审计表本身不该变成泄露面，
    而"两份敏感字段清单"迟早有一份漏掉新加的字段。
    """
    if _depth > 6:
        return value
    if isinstance(value, dict):
        return {
            k: ('[REDACTED]' if k in settings.OPERA_LOG_REDACT_KEYS else _redact(v, _depth + 1))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact(v, _depth + 1) for v in value]
    return value


def _error_text(e: Exception) -> str:
    """业务异常（`errors.BaseExceptionError`）的可读消息在 `.msg` 上，`str(e)` 可能是空串"""
    return getattr(e, 'msg', None) or str(e) or type(e).__name__


def _stringify(result: Any) -> str:
    """把工具返回值转成给模型看的字符串（截断，不是完整数据）"""
    if isinstance(result, str):
        text = result
    else:
        try:
            text = json.dumps(result, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            text = str(result)
    if len(text) > _RESULT_MAX_CHARS:
        return f'{text[:_RESULT_MAX_CHARS]}…（结果过长已截断，共 {len(text)} 字符）'
    return text


class ToolDispatcher:
    """工具可见性过滤 + 执行闸门 + 审计"""

    def visible_tools(self, user: Any) -> list[ToolSpec]:
        """这个用户能看到哪些工具。

        🔴 **过滤发生在把工具清单交给引擎之前**——模型压根不知道存在它无权调用的工具。
        这不是为了省 token：让模型看见一个它调不动的工具，它会反复尝试并向用户解释
        "我没有权限"，而用户看到的是一个像是系统坏了的循环。
        """
        candidates = tools_in_domains(settings.AI_TOOL_DOMAINS)
        visible = []
        for spec in candidates:
            if not user_can(user, spec.perm):
                continue
            if spec.mutating and not spec.self_authorized and not user_can_mutate(user):
                continue
            visible.append(spec)
        return visible

    def visible_schemas(self, user: Any) -> list[ToolSchema]:
        """交给引擎的那一份：同 `visible_tools`，但去掉了可执行体（见 `ToolSchema`）"""
        return [spec.schema for spec in self.visible_tools(user)]

    async def dispatch(  # ruff: ignore[complex-structure]
        self,
        call: ToolCallRequest,
        ctx: RunContext,
        *,
        pre_approved: bool = False,
    ) -> DispatchOutcome:
        """执行一次**被提议的**工具调用。

        :param call: 引擎提议的调用
        :param ctx: 运行上下文（`ctx.user` 是真正的责任人）
        :param pre_approved: 是否已经过用户二次确认（走 `/ai/tools/confirm` 时为 True）
        """
        started = time.perf_counter()
        spec = get_tool(call.name)

        # 模型给的工具名不可信：它会幻觉出不存在的工具。这不是异常，是一次失败的调用，
        # 要把失败**告诉模型**让它改口，而不是让整个对话 500。
        if spec is None or spec not in self.visible_tools(ctx.user):
            await self._audit(
                ctx, call, ToolInvocationStatus.DENIED, perm=None, error='工具不存在或无权调用', started=started
            )
            return DispatchOutcome(
                kind='denied',
                payload=f'工具 {call.name} 不存在或你没有调用它的权限。',
                summary=f'无权调用 {call.name}',
                duration_ms=int((time.perf_counter() - started) * 1000),
            )

        # 🔴 重新校验一次权限——绝不因为"它出现在可见清单里"就跳过。
        # 可见性是上一轮算的，而角色/菜单可能在这中间被改掉；更要紧的是：
        # 这条路径将来会被 sidecar 引擎直接打到，那时"可见清单"根本不在我们手上。
        if not user_can(ctx.user, spec.perm):
            await self._audit(ctx, call, ToolInvocationStatus.DENIED, perm=spec.perm, error='权限不足', started=started)
            return DispatchOutcome(
                kind='denied',
                payload=f'你没有执行 {spec.name} 所需的权限（{spec.perm}）。',
                summary='权限不足',
                perm=spec.perm,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )

        if spec.mutating:
            # 只读入口（MCP 第一版）：写操作要人确认，而外部客户端那一侧的「确认」我们验证不了
            # （客户端可以代答）。拦在这里而不是只拦在网关：以后加入口不用再记得这一条，且拒绝会进审计
            if ctx.read_only:
                await self._audit(
                    ctx,
                    call,
                    ToolInvocationStatus.DENIED,
                    perm=spec.perm,
                    error='只读入口不允许写操作',
                    started=started,
                )
                return DispatchOutcome(
                    kind='denied',
                    payload=f'{spec.name} 会改变系统数据，这个入口只开放查询；请到网页端的 AI 助手里操作。',
                    summary='只读入口',
                    perm=spec.perm,
                )
            if not spec.self_authorized and not user_can_mutate(ctx.user):
                await self._audit(
                    ctx, call, ToolInvocationStatus.DENIED, perm=spec.perm, error='非后台管理用户', started=started
                )
                return DispatchOutcome(kind='denied', payload='你不具备后台管理操作权限。', summary='无后台操作权限')

            if settings.AI_CONFIRM_MUTATING_TOOLS and not pre_approved:
                # 先预演再请人确认：预演就会失败的调用（部门不存在 / 不在你的数据范围 /
                # 同级重名…）不该先弹一张确认卡片，等人点了才报错
                try:
                    preview = await self._invoke(spec.preview, call, ctx) if spec.preview else None
                except Exception as e:
                    reason = _error_text(e)
                    await self._audit(
                        ctx,
                        call,
                        ToolInvocationStatus.FAILED,
                        perm=spec.perm,
                        error=f'预演失败：{reason}',
                        started=started,
                    )
                    return DispatchOutcome(
                        kind='failed',
                        payload=f'无法执行：{reason}',
                        summary=f'{spec.name} 预演未通过',
                        perm=spec.perm,
                        duration_ms=int((time.perf_counter() - started) * 1000),
                    )
                if not preview:
                    safe_args = json.dumps(_redact(call.arguments), ensure_ascii=False)
                    preview = f'将执行：{spec.name}\n参数：{safe_args}'
                token = await self._stage_confirm(spec, call, ctx, preview)
                await self._audit(ctx, call, ToolInvocationStatus.PENDING_CONFIRM, perm=spec.perm, started=started)
                return DispatchOutcome(
                    kind='confirm_required',
                    payload='该操作会改变系统数据，已请用户确认；在用户确认前不要重复调用。',
                    summary=f'等待确认：{spec.name}',
                    confirm_token=token,
                    preview=preview,
                )

        try:
            # 数据范围在 `_invoke` 里锚定（见那里的注释）
            result = await self._invoke(spec.handler, call, ctx)
        except TypeError as e:
            # 模型填错参数属于日常，不是系统故障——把错误回给它让它重填
            await self._audit(ctx, call, ToolInvocationStatus.FAILED, perm=spec.perm, error=str(e), started=started)
            return DispatchOutcome(
                kind='failed',
                payload=f'参数不正确：{e}',
                summary=f'{spec.name} 参数错误',
                perm=spec.perm,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )
        except Exception as e:
            log.exception(f'AI 工具 {spec.name} 执行失败')
            reason = _error_text(e)
            await self._audit(ctx, call, ToolInvocationStatus.FAILED, perm=spec.perm, error=reason, started=started)
            return DispatchOutcome(
                kind='failed',
                payload=f'执行失败：{reason}',
                summary=f'{spec.name} 执行失败',
                perm=spec.perm,
                duration_ms=int((time.perf_counter() - started) * 1000),
            )

        payload = _stringify(result)
        await self._audit(ctx, call, ToolInvocationStatus.SUCCESS, perm=spec.perm, result=payload, started=started)
        return DispatchOutcome(
            kind='ok',
            payload=payload,
            summary=f'{spec.name} 执行成功',
            perm=spec.perm,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )

    @staticmethod
    async def _invoke(fn: Callable[..., Awaitable[Any]], call: ToolCallRequest, ctx: RunContext) -> Any:
        """按签名注入 `db` / `ctx`，**在调用者的数据范围里**执行 handler 或 preview。

        🔴 行级数据权限由**这里**负责锚定，不依赖「中间件反正会设」。
        `_current_user` 为 None 时 `DataScopedCRUD` 不加任何过滤（= 看全部）——
        对 Celery / CLI 是对的，对「认证方式不是 JWT 的入口」就是静默越权。
        而 `set_current_user()` 全仓只有 `jwt_auth_middleware` 调：哪天接上
        API key / MCP / sidecar，忘了设就是受限用户通过 AI 拿到全量，没有任何现象。
        dispatch 是工具执行的**唯一**通路，在这里锚定 = 以后加入口不用再想这件事。
        预演也走这里：它读的是同一批数据，范围必须一致。
        """
        kwargs = dict(call.arguments)
        params = inspect.signature(fn).parameters
        if 'db' in params:
            kwargs['db'] = ctx.db
        if 'ctx' in params:
            kwargs['ctx'] = ctx
        with scoped_to_user(ctx.user):
            return await fn(**kwargs)

    async def _stage_confirm(self, spec: ToolSpec, call: ToolCallRequest, ctx: RunContext, preview: str) -> str:
        """把一次待确认的调用暂存到 Redis，返回一次性令牌。

        `channel` / `preview` 一起存：MCP 发起的写操作要在**网页**上确认，确认页得能
        读出「会变成什么」；执行时的审计也要还记得是哪个外部系统发起的。
        """
        # 🔴 带字母前缀：MCP 发起的写操作会把令牌放进网页链接（`/ai/confirm?token=…`），而路由层对
        # search 值跑 JSON.parse（`apps/web/src/lib/search-params.ts`）。纯十六进制恰好只含数字和一个 e
        # 时（`123e4567…`）会被解析成数字，确认页拿到的令牌就不对了 —— 表现是一句查不出原因的「已过期」
        token = f'cf_{uuid.uuid4().hex}'
        await redis_client.set(
            f'{settings.AI_CONFIRM_REDIS_PREFIX}:{token}',
            json.dumps(
                {
                    'tool': spec.name,
                    'arguments': call.arguments,
                    'user_id': str(ctx.user.id),
                    'conversation_id': str(ctx.conversation_id),
                    'channel': ctx.channel,
                    'preview': preview,
                },
                ensure_ascii=False,
            ),
            ex=settings.AI_CONFIRM_TOKEN_EXPIRE_SECONDS,
        )
        return token

    async def _audit(
        self,
        ctx: RunContext,
        call: ToolCallRequest,
        status: ToolInvocationStatus,
        *,
        perm: str | None,
        result: str | None = None,
        error: str | None = None,
        started: float,
    ) -> None:
        """落一行审计。

        🔴 审计失败不能把业务也带崩：这里吞掉异常只记日志。
        代价是极端情况下会丢审计——但让一次数据库抖动把正在进行的对话整个打断，
        对用户是更糟的失败方式，而且丢的那条审计本来也写不进去。

        🔴 **光吞异常不够，必须放进 SAVEPOINT。** flush 失败之后 SQLAlchemy 会把
        整个事务标成待回滚，同一会话上后面的每个查询都是 `PendingRollbackError` ——
        吞掉的只是这一次的异常，这一轮对话里后面所有工具都「执行失败」。
        `begin_nested` 让失败只回滚审计这一行（`tests/test_ai_audit.py`，实测修复前红）。
        """
        from backend.plugin.ai.crud.crud_tool_invocation import ai_tool_invocation_dao

        try:
            async with ctx.db.begin_nested():
                await ai_tool_invocation_dao.create(
                    ctx.db,
                    conversation_id=ctx.conversation_id,
                    user_id=ctx.user.id,
                    tool_name=call.name,
                    status=status.value,
                    params_redacted=json.dumps(_redact(call.arguments), ensure_ascii=False),
                    result_summary=result,
                    permission_code=perm,
                    error=error,
                    duration_ms=int((time.perf_counter() - started) * 1000),
                    channel=ctx.channel,
                )
        except Exception:
            log.exception('AI 工具审计落库失败（不影响本次调用结果）')


tool_dispatcher = ToolDispatcher()
