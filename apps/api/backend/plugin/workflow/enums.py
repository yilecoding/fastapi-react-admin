from backend.common.enums import StrEnum


class DefinitionStatus(StrEnum):
    """流程定义状态"""

    #: 从没发布过。草稿可以随便改，发起页里看不到它
    draft = 'draft'
    #: 有一个已发布版本，可以发起。之后再改的是草稿，不影响已发布的那一版
    published = 'published'
    #: 停用：不能再发起，在途实例照常按快照走完
    disabled = 'disabled'


class InstanceStatus(StrEnum):
    """审批实例状态 —— 只记「审批走到哪」，业务生命周期归业务自己（#107 设计 1）"""

    running = 'running'
    approved = 'approved'
    rejected = 'rejected'
    withdrawn = 'withdrawn'
    terminated = 'terminated'


class TaskStatus(StrEnum):
    """待办状态"""

    pending = 'pending'
    done = 'done'
    #: 节点已经结束（或签别人先办了 / 实例被驳回撤回终止），这条没人办了
    canceled = 'canceled'
    #: 转给了别人。新办理人另起一行，这一行留作轨迹
    transferred = 'transferred'


class Action(StrEnum):
    """动作。数值是前后端契约，能力信封里的 `action` 就是它"""

    approve = 'approve'
    reject = 'reject'
    withdraw = 'withdraw'
    transfer = 'transfer'
    cc = 'cc'
    remind = 'remind'
    terminate = 'terminate'
    #: 退回到发起人或之前走过的某个审批节点（飞书的「退回」）。实例不结束，同一张单接着走
    send_back = 'send_back'
    #: 管理员改办理人：审批人离职 / 长期不在时把卡住的待办交给别人（不需要原办理人点头）
    reassign = 'reassign'
    #: 拿回：同意之后、下一步还没人动之前，把单收回到自己手上（点错了同意）
    take_back = 'take_back'
    #: 加签：临时拉人进这一步。「在我之前」= 他们都同意后回到我；「在我之后」= 我同意，他们都同意后才往下走
    add_sign = 'add_sign'


class ActorType(StrEnum):
    """谁做的这个动作。

    预留 system（#107 设计 6.6「轨迹的 actor 不假设一定是人」）：节点没人可办时的
    自动跳过 / 自动驳回现在就会用到，以后超时自动处理、AI 节点也落在这里。
    """

    user = 'user'
    system = 'system'


class ApprovalMode(StrEnum):
    """多人节点怎么算通过"""

    #: 或签：一人同意即通过，其余人的待办作废
    any = 'any'
    #: 会签：全部同意才通过；任何一人驳回整个实例结束
    all = 'all'
    #: 依次审批：按审批人的顺序一个一个来，前一个同意了才轮到下一个
    seq = 'seq'


class OnEmpty(StrEnum):
    """审批人规则解析不到人时怎么办 —— 必须显式选，不静默放行（#107 设计 2）"""

    #: 直接驳回，并在轨迹里写明原因
    reject = 'reject'
    #: 跳过这个节点
    skip = 'skip'
    #: 转给超级管理员
    admin = 'admin'


class FieldPerm(StrEnum):
    """节点上的字段权限"""

    hidden = 'hidden'
    readonly = 'readonly'
    editable = 'editable'


#: 表单审批的 biz_type —— 内置的 `FormHandler`，数据在 `wf_instance.form_data`
FORM_BIZ_TYPE = 'form'

#: 管理员终止在途实例要的权限码（菜单种子里挂在「实例监控」下面）
PERM_TERMINATE = 'workflow:instance:terminate'

#: 管理员改办理人 / 离职交接要的权限码。和「终止」分开：能把卡住的单交给别人，不等于能直接作废它
PERM_REASSIGN = 'workflow:instance:reassign'

#: 实例监控（看全部实例）要的权限码
PERM_MONITOR = 'workflow:instance:list'
