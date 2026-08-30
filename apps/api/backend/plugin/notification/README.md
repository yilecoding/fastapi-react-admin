# 消息通知中心

站内收件箱：一条通知一行（`sys_notification`），`recipient_id` 为空表示全员广播；
已读状态存在关联表 `sys_notification_read` 里，**广播不 fan-out 成 N 行**。

- 读自己的收件箱、标记已读**不需要权限码**，登录即可，服务端按 `current_user.id` 强制过滤
- 「管理员手动发通知给指定人」走 `sys:notification:send`
- 公告（`plugin/notice`）发布时会顺带写一条 `category=1` 的广播通知并推 `notification:new`

设计取舍见仓库 issue #7。
