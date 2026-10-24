"""引擎无关的核心类型。

🔴 **这个文件不许 import 任何具体引擎**（`engines/` 下的东西）。它是三层可插拔架构
里那条"接缝"本身：引擎、入口、工具三者只通过这里的类型互相认识。
反向依赖一旦出现，"换引擎只改一个适配器文件"这句话就不成立了。
"""

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.background import BackgroundTasks

from backend.plugin.ai.core.events import AgentEvent


@dataclass(frozen=True, slots=True)
class ToolSchema:
    """交给引擎的工具描述——**纯数据，没有可执行体**。

    🔴 引擎只能拿到这个，拿不到 `ToolSpec`。原来端口收的是带 `handler` 的
    `ToolSpec`，「引擎只是建议者」就只是一句约定：pydantic-ai spike 实测，
    适配器里写一句 `Tool(spec.handler)` 框架就直接执行了，权限码 / 二次确认 /
    审计全部跳过，不报任何错。现在引擎手上没有能执行的东西，想执行只能
    提议一个 `ToolCallRequest` 交给 `tool_dispatcher.dispatch()`。
    守卫：`tests/test_ai_security.py::TestEnginesNeverHoldExecutables`。

    翻译成 OpenAI function schema / pydantic-ai 的 `ToolDefinition` / MCP tool
    是各个引擎适配器的责任。
    """

    name: str
    description: str
    parameters: dict[str, Any]
    mutating: bool = False
    """给引擎 / 入口做展示用（如 MCP 的 `readOnlyHint`）。**安全判定不看它**，看 dispatcher。"""


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """一个工具的完整描述——**与用哪个引擎无关**，且**只在 dispatcher 手里**。

    工具作者只写这个（经 `@ai_tool`）；交给引擎的是它的 `schema` 投影。
    """

    name: str
    description: str
    parameters: dict[str, Any]
    """JSON Schema（object）。由 `registry` 从函数签名自动推断，不手写。"""

    handler: Callable[..., Awaitable[Any]]
    domain: str
    """所属工具域，对应 `AI_TOOL_DOMAINS`。整域可开关。"""

    perm: str | None = None
    """权限码。`None` = 不要求业务权限（仅限**不读业务数据**的工具，如健康检查）。"""

    mutating: bool = False
    """是否会改变系统状态。`True` 的工具走二次确认，且额外要求 `is_staff`。"""

    self_authorized: bool = False
    """写操作的授权**由业务自己判定**，不要求 `is_staff`（只对 `mutating=True` 有意义）。

    给审批这类「普通员工本来就能做」的写操作用：审批中心的接口刻意不走 RBAC（挂了的话非员工连「同意」都点不了），
    能不能做由能力信封判。照搬 `is_staff` 那道闸，就成了「只有员工能在对话里审批」。
    🔴 声明了它的工具**自己**必须把授权判完（审批走 `execute()` 的能力信封），dispatcher 不再替它兜 ——
    所以只给登记过的工具开（`test_ai_security.py::test_self_authorized_tools_are_an_explicit_list`）。"""

    preview: Callable[..., Awaitable[str]] | None = None
    """变更类工具的**预演**：入参同 handler（`db` / `ctx` 同样注入），只读不写，
    返回给人看的「会变成什么」。抛异常 = 这次调用在请人确认之前就被拒掉。"""

    plugin: str | None = None
    """工具是哪个**别的**插件带来的（registry 按模块路径 `backend.plugin.<插件>.ai_tools` 填；AI 插件自己的是 `None`）。

    🔴 插件被停用时它的工具要一起消失：停用只拦得住插件自己的路由（`PluginStatusChecker`），
    而工具是 AI 插件直接调的 —— 原来停用了审批插件，对话里照样能同意 / 驳回 / 转交。
    dispatcher 按这个字段查插件状态（`ToolDispatcher.off_plugins`）"""

    wants_db: bool = False
    """handler 是否声明了 `db` 参数（由 registry 检测，dispatcher 据此注入会话）。"""

    wants_ctx: bool = False
    """handler 是否声明了 `ctx` 参数。

    要算数据范围（`filter_data_permission_for_user`）的工具必须声明它——
    数据范围是**按调用者**算的，拿不到 user 就只能退化成"看全部"，
    而那正是最不该静默发生的事。"""

    @property
    def schema(self) -> ToolSchema:
        """去掉可执行体的投影 —— 引擎能看到的只有这些"""
        return ToolSchema(
            name=self.name, description=self.description, parameters=self.parameters, mutating=self.mutating
        )


@dataclass(slots=True)
class RunContext:
    """一次对话运行的上下文。

    `user` 是**发起这次对话的登录用户**——工具的权限校验和数据范围都以他为准，
    绝不是什么"系统账号"。
    """

    user: Any
    conversation_id: int
    db: AsyncSession
    provider: Any
    max_tool_rounds: int = 5
    background_tasks: BackgroundTasks = field(default_factory=BackgroundTasks)
    """工具挂的**提交后**动作（如清用户缓存）。由开会话的那一方在 commit 之后执行 ——
    提交前清缓存，并发请求会在提交前把旧数据重新缓存回去。"""
    channel: str | None = None
    """调用入口，原样进审计（`None` = 网页对话，`mcp:<client id>` = 外部系统）"""
    read_only: bool = False
    """只读入口：dispatcher 直接拒绝变更类工具（并审计），不出预演、不发确认令牌"""
    user_said: list[str] | None = None
    """这段对话里用户**亲口**说过的话（网页对话从历史里取）。给「参数必须是用户原话」的工具核对用 ——
    审批意见：工具描述里写了「不要替他拟」，真模型（Qwen3-VL）照样填了一句「用户未提供驳回理由」。
    `None` = 这个入口拿不到原话（MCP：外部系统转述），那时靠网页确认页上原样显示的意见兜底"""
    extra: dict[str, Any] = field(default_factory=dict)
    pinned: dict[str, Any] = field(default_factory=dict)
    """预演时**钉住**的东西，跟着确认令牌存、确认后执行时原样带回（只放 JSON 能存的值）。

    🔴 确认卡片上写的是预演那一刻解析出来的结果（「转交给 张伟（zhangwei）」），而令牌里只存了模型给的参数（「张伟」）。
    执行时再按名字解析一遍，令牌有效的这几分钟里有人改了名 / 停了号，转给的就不是卡片上那个人了。
    预演把解析结果放进这里，执行时用它 —— 人确认的是什么就执行什么"""


@dataclass(frozen=True, slots=True)
class ToolCallRequest:
    """引擎**提议**的一次工具调用。

    ⚠️ 措辞是"提议"不是"调用"：引擎（不管是进程内的循环还是 sidecar 里的 pi）
    对系统来说都是不受信任的建议者，能不能真的执行由 `ToolDispatcher` 说了算。
    """

    call_id: str
    name: str
    arguments: dict[str, Any]


@runtime_checkable
class AgentRuntimePort(Protocol):
    """**唯一的"换脑"点。**

    任何引擎——进程内 OpenAI 兼容循环、Node sidecar 里的 pi、官方 ai 插件——
    只要实现这个协议就能被 `AI_AGENT_ENGINE` 选中，业务代码一行不用改。
    """

    name: str

    def run(
        self,
        history: list[dict[str, Any]],
        tools: list[ToolSchema],
        ctx: RunContext,
    ) -> AsyncIterator[AgentEvent]:
        """驱动一轮对话，产出引擎无关的事件流。

        :param history: OpenAI 形状的消息列表（已含本次用户输入）
        :param tools: **已经按调用者权限过滤过**的工具描述——引擎看不到无权调用的工具，
            也拿不到任何工具的可执行体
        :param ctx: 运行上下文
        """
        ...
