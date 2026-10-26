INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES (2049629108262010880, N'消息中心', 'Notification', '/notification', 7, 'mdi:bell-outline', 1, NULL, 1, 1, '', NULL, NULL, GETDATE(), NULL);

INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES (2049629108262010881, N'发送通知', 'SendNotification', NULL, 0, NULL, 2, 'sys:notification:send', 1, 0, '', NULL, 2049629108262010880, GETDATE(), NULL);

INSERT INTO sys_role_menu (id, role_id, menu_id)
VALUES
(3000000000000000071, 2048601263515500544, 2049629108262010880),
(3000000000000000072, 3000000000000000011, 2049629108262010880),
(3000000000000000073, 3000000000000000012, 2049629108262010880),
(3000000000000000074, 3000000000000000013, 2049629108262010880);

INSERT INTO sys_notification (id, title, content, category, link, recipient_id, created_time, updated_time, deleted, deleted_time)
VALUES
(3000000000000000081, N'欢迎使用消息中心', N'铃铛里的红点是未读数，点标题可以直接跳到对应页面。这条是「系统」分类的示例。', 0, '/dashboard', NULL, GETDATE(), NULL, 0, NULL),
(3000000000000000082, N'系统升级公告：新增定时任务与数据权限模块', N'本次升级新增「定时任务调度」与「数据权限矩阵」两个模块，详情见通知公告页。', 1, '/plugins/notice', NULL, GETDATE(), NULL, 0, NULL),
(3000000000000000083, N'你的账号资料待完善', N'这条是只发给 admin 的定向通知示例——其他账号看不到它。', 0, '/profile', 2048601263834267648, GETDATE(), NULL, 0, NULL);

INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2240000000000000001, N'消息推送', 'NotifyCenter', '/notify', 11, 'mdi:bell-cog-outline', 0, NULL, 1, 1, '', NULL, NULL, GETDATE(), NULL),
(2240000000000000002, N'通知策略', 'NotifyPolicy', '/notify/policy', 1, 'mdi:tune-variant', 1, NULL, 1, 1, '', NULL, 2240000000000000001, GETDATE(), NULL),
(2240000000000000003, N'投递记录', 'NotifyDelivery', '/notify/delivery', 2, 'mdi:send-check-outline', 1, NULL, 1, 1, '', NULL, 2240000000000000001, GETDATE(), NULL),
(2240000000000000004, N'查询', 'QueryNotifyPolicy', NULL, 0, NULL, 2, 'sys:notification:policy:list', 1, 0, '', NULL, 2240000000000000002, GETDATE(), NULL),
(2240000000000000005, N'修改', 'EditNotifyPolicy', NULL, 1, NULL, 2, 'sys:notification:policy:edit', 1, 0, '', NULL, 2240000000000000002, GETDATE(), NULL),
(2240000000000000006, N'查询', 'QueryNotifyDelivery', NULL, 0, NULL, 2, 'sys:notification:delivery:list', 1, 0, '', NULL, 2240000000000000003, GETDATE(), NULL),
(2240000000000000007, N'重发', 'ResendNotifyDelivery', NULL, 1, NULL, 2, 'sys:notification:delivery:resend', 1, 0, '', NULL, 2240000000000000003, GETDATE(), NULL);

INSERT INTO task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
VALUES (2240000000000000101, N'通知投递', 'notification.deliver_pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 60, 0, 15, 'seconds', '* * * * *', 0, 1, 0, NULL, N'每 15 秒把到点的通知邮件 / 短信发出去（安全网：写了投递的事务提交后也会立刻踢一次）。停用后投递行会一直停在「待发」', GETDATE(), NULL, 0, NULL);
