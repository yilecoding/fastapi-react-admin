from backend.common.socketio.server import sio, user_room


async def task_notification(msg: str) -> None:
    """
    任务通知

    :param msg: 通知信息
    :return:
    """
    await sio.emit('task_notification', {'msg': msg})


async def notification_new(user_id: int | None = None) -> None:
    """
    有新的站内通知。

    ⚠️ **事件本身刻意不带内容**。带上内容就意味着 socket 这条通道也要做一遍
    「这个人能不能看这条」的权限判断 —— 而它没有请求上下文、没有 RBAC 依赖链，
    做出来的一定是第二套、且会和 REST 那套慢慢漂移。前端收到这个事件之后
    只做一件事：重新拉 `unread-count` / 列表，权限判断仍然只有 REST 一处。

    :param user_id: 目标用户 ID；`None` = 广播给所有在线连接
    :return:
    """
    if user_id is None:
        await sio.emit('notification:new', {})
    else:
        await sio.emit('notification:new', {}, room=user_room(user_id))


async def workflow_todo_changed(user_id: int) -> None:
    """某人的审批待办变了（新来一条 / 被别人办掉 / 实例结束作废）。

    和 `notification_new` 同一个口径：**不带内容**，前端收到后重新拉待办数和列表。
    办理人不另收站内通知（#107 设计 7：同一件事不在铃铛上出现两次），
    所以这条事件是待办数实时刷新的唯一来源 —— 推送失败也只是慢一点，下次拉取照样对。

    :param user_id: 目标用户 ID
    :return:
    """
    await sio.emit('workflow:todo', {}, room=user_room(user_id))
