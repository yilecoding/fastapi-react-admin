"""表单 schema 与流程模型的形状（#107 设计 2 / 6.5）

🔴 **只用来校验，不用来存。** 存储和快照一律是原始 JSON 字符串：这里解析成对象再
`model_dump()` 回去，对象上没有的字段会被静默丢掉 —— avc-bp 的 `approveMode`、
`actionPolicy` 都是这么丢的。所以运行时读的是 `dict`，Pydantic 只在保存 / 发布时
跑一遍确认形状对，结果扔掉。

`extra='allow'`：前端以后加的展示用字段（坐标、颜色）不该让保存失败。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.plugin.workflow.enums import ApprovalMode, FieldPerm, OnEmpty


# 字段名是前后端共用的 JSON 契约（camelCase），不按 Python 命名改
class _Shape(BaseModel):
    model_config = ConfigDict(extra='allow')


# ── 表单 ─────────────────────────────────────────────────────────────────────

FieldType = Literal[
    'text',
    'textarea',
    'number',
    'amount',
    'date',
    'daterange',
    'select',
    'multiselect',
    'user',
    'dept',
    'attachment',
    'description',
    'table',
]

#: 能出现在明细表列里的控件 —— 不允许 table 套 table（#107：明细表只允许一层）
COLUMN_TYPES = frozenset({'text', 'textarea', 'number', 'amount', 'date', 'select'})

#: 能当条件变量的控件。附件、说明、明细表、多行文本拿来做分支没有意义
CONDITION_TYPES = frozenset({'text', 'number', 'amount', 'date', 'select', 'multiselect', 'user', 'dept'})


class FieldOption(_Shape):
    label: str
    value: str


class Calc(_Shape):
    """自动计算（只用在 number / amount 上）。值由服务端算，填了也不收。

    - `days`：日期区间 `field` 的天数，含首尾（11-02 ~ 11-06 = 5 天）
    - `sum`：明细表 `field` 里 `column` 那一列的合计
    """

    kind: Literal['days', 'sum']
    field: str
    column: str | None = None


class FormField(_Shape):
    # 字段用生成的稳定 id 引用，不用 label：改标签不影响条件和历史数据
    id: str = Field(pattern=r'^[A-Za-z][A-Za-z0-9_]{0,63}$')
    type: FieldType
    label: str = Field(min_length=1, max_length=64)
    required: bool = False
    placeholder: str | None = None
    #: select / multiselect
    options: list[FieldOption] | None = None
    #: amount 的小数位
    precision: int | None = Field(None, ge=0, le=6)
    #: user / dept 是否多选
    multiple: bool = False
    #: textarea / description 的正文
    content: str | None = None
    #: table 的列
    columns: list[FormField] | None = None
    #: 显示条件：不成立时这个字段不显示、不校验、值不保存（例：「请假类型 = 病假」才要「病假证明」）。
    #: 只能引用排在它**前面**的字段（发布校验管），这样按顺序算一遍就定了，不会互相依赖
    visibleWhen: Cond | None = None  # ruff:ignore[mixed-case-variable-in-class-scope]
    calc: Calc | None = None


class FormSchema(_Shape):
    schemaVersion: Literal[1] = 1  # ruff:ignore[mixed-case-variable-in-class-scope]
    fields: list[FormField] = Field(default_factory=list)


# ── 流程 ─────────────────────────────────────────────────────────────────────


class Cond(_Shape):
    """结构化条件：`all` / `any` 嵌套，叶子是 `var op value`。

    不用字符串表达式：avc-bp 用正则解析 `path op literal`，不支持 and/or；
    结构化写法天然能表达 and/or，也不用担心注入。
    """

    all: list[Cond] | None = None
    any: list[Cond] | None = None
    var: str | None = None
    op: Literal['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'contains', 'empty', 'not_empty'] | None = None
    value: Any = None


AssigneeKind = Literal['user', 'role', 'dept_leader', 'initiator', 'var_user', 'select_on_start']


class AssigneeRule(_Shape):
    kind: AssigneeKind
    #: user：用户 ID 列表（字符串，硬纪律 6）
    user_ids: list[str] | None = None
    #: role：角色 ID 列表
    role_ids: list[str] | None = None
    #: dept_leader：往上第几级（1 = 发起人所在部门的负责人）
    level: int | None = Field(None, ge=1, le=10)
    #: var_user：取哪个 user 类型字段的值
    field: str | None = None
    #: role 的范围限定：对解析结果再取一次交集
    scope: Literal['none', 'initiator_dept', 'initiator_dept_tree'] = 'none'


class StartNode(_Shape):
    type: Literal['start']
    id: str
    #: 发起人的字段权限：没配 = 可填。hidden = 发起人既不填也看不到（留给审批人填的那种），
    #: readonly = 看得到不能填
    fieldPerms: dict[str, FieldPerm] = Field(default_factory=dict)  # ruff:ignore[mixed-case-variable-in-class-scope]
    next: Node | None = None


class Timeout(_Shape):
    """超时处理：待办到了这个人手上 `hours` 小时还没办"""

    hours: int = Field(ge=1, le=720)
    #: remind 每 `hours` 小时提醒一次（最多 3 次）· approve 自动同意 · reject 自动驳回整单
    action: Literal['remind', 'approve', 'reject']


class ApprovalNode(_Shape):
    type: Literal['approval']
    id: str
    name: str = Field(min_length=1, max_length=64)
    mode: ApprovalMode = ApprovalMode.any
    assignee: AssigneeRule | None = None
    onEmpty: OnEmpty = OnEmpty.reject  # ruff:ignore[mixed-case-variable-in-class-scope]
    #: null = 继承业务默认集；[] = 只保留必备动作（同意 / 驳回）
    actions: list[str] | None = None
    fieldPerms: dict[str, FieldPerm] = Field(default_factory=dict)  # ruff:ignore[mixed-case-variable-in-class-scope]
    timeout: Timeout | None = None
    next: Node | None = None


class CcNode(_Shape):
    type: Literal['cc']
    id: str
    name: str = Field('抄送', max_length=64)
    targets: list[AssigneeRule] = Field(default_factory=list)
    next: Node | None = None


class Branch(_Shape):
    id: str
    name: str = Field(max_length=64)
    default: bool = False
    when: Cond | None = None
    child: Node | None = None


class ConditionNode(_Shape):
    type: Literal['condition']
    id: str
    name: str = Field('条件分支', max_length=64)
    branches: list[Branch] = Field(min_length=2)
    next: Node | None = None


Node = Annotated[ApprovalNode | CcNode | ConditionNode, Field(discriminator='type')]


class FlowModel(_Shape):
    schemaVersion: Literal[1] = 1  # ruff:ignore[mixed-case-variable-in-class-scope]
    root: StartNode


for _m in (FormField, Cond, StartNode, ApprovalNode, CcNode, Branch, ConditionNode, FlowModel):
    _m.model_rebuild()


# FormField 里引用了后面才定义的 Cond
FormField.model_rebuild()
FormSchema.model_rebuild()
