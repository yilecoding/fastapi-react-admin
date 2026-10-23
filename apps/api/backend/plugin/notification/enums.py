from backend.common.enums import IntEnum


class NotificationCategory(IntEnum):
    """站内通知分类

    `TASK` 的生产者是后台导出（`app/task/tasks/export/tasks.py`）：生成完 / 失败时给发起人发一条，
    链到个人中心的「导出记录」。调度任务的执行事件仍然走 socket.io 的瞬时 toast，不落库
    （见 `app/task/tasks/base.py: TaskBase`）。
    """

    SYSTEM = 0
    ANNOUNCEMENT = 1
    TASK = 2
    #: 审批流（#107）：抄送、催办、结果通知、撤回告知已审批的人。
    #: 办理人的待办**不发**通知 —— 靠待办数感知，避免同一件事在铃铛上出现两次
    WORKFLOW = 3
