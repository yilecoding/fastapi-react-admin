from backend.common.enums import IntEnum


class NotificationCategory(IntEnum):
    """站内通知分类

    ⚠️ `TASK` 目前**没有生产者**：任务执行事件走 socket.io 的瞬时 toast，不落库
    （见 `app/task/tasks/base.py: TaskBase`）。留着这个取值是因为「任务失败要留痕」
    是可预期的下一步，而分类的数值一旦发出去就不该再改。
    """

    SYSTEM = 0
    ANNOUNCEMENT = 1
    TASK = 2
    #: 审批流（#107）：抄送、催办、结果通知、撤回告知已审批的人。
    #: 办理人的待办**不发**通知 —— 靠待办数感知，避免同一件事在铃铛上出现两次
    WORKFLOW = 3
