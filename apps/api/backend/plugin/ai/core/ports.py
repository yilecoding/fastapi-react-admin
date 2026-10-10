"""引擎无关的核心类型。

🔴 **这个文件不许 import 任何具体引擎**（`engines/` 下的东西）。它是三层可插拔架构
里那条"接缝"本身：引擎、入口、工具三者只通过这里的类型互相认识。
反向依赖一旦出现，"换引擎只改一个适配器文件"这句话就不成立了。
"""

from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from sqlalchemy.ext.asyncio import AsyncSession

from backend.plugin.ai.core.events import AgentEvent


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """一个工具的完整描述——**与用哪个引擎无关**。

    工具作者只写这个；翻译成 OpenAI function schema / pi 的 tool 定义 / MCP tool
    是各个引擎适配器的责任。这样新增工具时不需要知道当前跑的是哪个引擎。
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

    wants_db: bool = False
    """handler 是否声明了 `db` 参数（由 registry 检测，dispatcher 据此注入会话）。"""

    wants_ctx: bool = False
    """handler 是否声明了 `ctx` 参数。

    要算数据范围（`filter_data_permission_for_user`）的工具必须声明它——
    数据范围是**按调用者**算的，拿不到 user 就只能退化成"看全部"，
    而那正是最不该静默发生的事。"""


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
    extra: dict[str, Any] = field(default_factory=dict)


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
        tools: list[ToolSpec],
        ctx: RunContext,
    ) -> AsyncIterator[AgentEvent]:
        """驱动一轮对话，产出引擎无关的事件流。

        :param history: OpenAI 形状的消息列表（已含本次用户输入）
        :param tools: **已经按调用者权限过滤过**的工具集——引擎看不到无权调用的工具
        :param ctx: 运行上下文
        """
        ...
