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
