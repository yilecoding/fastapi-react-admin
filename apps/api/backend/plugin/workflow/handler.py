"""业务接入契约（#107 设计 6）

两种接入方式共用同一个运行时：

- **表单审批**：内置的 `FormHandler`，数据在 `wf_instance.form_data`，不写代码
- **业务审批**：业务模块实现 `WorkflowBizHandler` 并 `register_handler()`，
  在自己的事务里调 `runtime_service.start_for_biz()`。流程起不来就整单回滚

`on_finished` 在审批事务内同步执行，**只允许改业务状态**。副作用（通知、外推）
放到提交之后 —— avc-bp 被诟病的就是回调里干了重活，一出错把审批一起回滚。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, ClassVar, Protocol

from backend.plugin.workflow.enums import FORM_BIZ_TYPE, Action, InstanceStatus

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class BizSnapshot:
    title: str
    summary: str | None = None
    #: 条件求值用的变量（业务审批没有表单，条件变量从这里来）
    variables: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class FinishEvent:
    status: InstanceStatus
    #: 驳回意见 / 撤回原因 / 终止原因。avc-bp 没有这个字段时，终止原因取的是
    #: payloadJson，一整坨 JSON 被塞进了 varchar(300)
    opinion: str | None
    actor_id: int | None


class WorkflowBizHandler(Protocol):
    biz_type: ClassVar[str]
    #: 节点 `actions` 为 null 时继承的可选动作（必备的同意 / 驳回不在里面）
    default_actions: ClassVar[frozenset[Action]]

    async def snapshot(self, db: AsyncSession, biz_id: int | None, form_data: dict[str, Any]) -> BizSnapshot: ...

    async def assert_start_allowed(self, db: AsyncSession, biz_id: int | None, user_id: int) -> None: ...

    async def assert_view_allowed(self, db: AsyncSession, biz_id: int | None, user_id: int) -> None: ...

    async def on_finished(self, db: AsyncSession, biz_id: int | None, event: FinishEvent) -> None: ...


class FormHandler:
    """表单审批：没有业务表，所以「开始 / 查看 / 结束」都没有额外判断"""

    biz_type: ClassVar[str] = FORM_BIZ_TYPE
    default_actions: ClassVar[frozenset[Action]] = frozenset({
        Action.transfer,
        Action.cc,
        Action.send_back,
        Action.add_sign,
    })

    async def snapshot(self, db: AsyncSession, biz_id: int | None, form_data: dict[str, Any]) -> BizSnapshot:
        # 标题由运行时拼（定义名 + 发起人），这里只给变量
        return BizSnapshot(title='', variables=form_data)

    async def assert_start_allowed(self, db: AsyncSession, biz_id: int | None, user_id: int) -> None:
        return None

    async def assert_view_allowed(self, db: AsyncSession, biz_id: int | None, user_id: int) -> None:
        return None

    async def on_finished(self, db: AsyncSession, biz_id: int | None, event: FinishEvent) -> None:
        return None


_REGISTRY: dict[str, WorkflowBizHandler] = {}


def register_handler(handler: WorkflowBizHandler) -> None:
    """按 biz_type 注册。**重复注册直接抛错**（avc-bp 也是这么做的）：
    两个模块抢同一个 biz_type 时，后注册的静默覆盖前一个，审批结束回调到错的业务上
    """
    if handler.biz_type in _REGISTRY:
        raise ValueError(f'biz_type {handler.biz_type!r} 已经注册过了')
    _REGISTRY[handler.biz_type] = handler


def unregister_handler(biz_type: str) -> None:
    """只给测试用"""
    _REGISTRY.pop(biz_type, None)


def get_handler(biz_type: str) -> WorkflowBizHandler:
    try:
        return _REGISTRY[biz_type]
    except KeyError:
        raise LookupError(f'没有注册 biz_type {biz_type!r} 的处理器') from None


register_handler(FormHandler())
