insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108262010880, '消息中心', 'Notification', '/notification', 7, 'mdi:bell-outline', 1, null, 1, 1, '', null, null, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108262010881, '发送通知', 'SendNotification', null, 0, null, 2, 'sys:notification:send', 1, 0, '', null, 2049629108262010880, now(), null);

insert into sys_role_menu (id, role_id, menu_id)
values
(4000000000000000071, 2048601269345583104, 2049629108262010880),
(4000000000000000072, 4000000000000000011, 2049629108262010880),
(4000000000000000073, 4000000000000000012, 2049629108262010880),
(4000000000000000074, 4000000000000000013, 2049629108262010880);

insert into sys_notification (id, title, content, category, link, recipient_id, created_time, updated_time, deleted, deleted_time)
values
(4000000000000000081, '欢迎使用消息中心', '铃铛里的红点是未读数，点标题可以直接跳到对应页面。这条是「系统」分类的示例。', 0, '/dashboard', null, now(), null, 0, null),
(4000000000000000082, '系统升级公告：新增定时任务与数据权限模块', '本次升级新增「定时任务调度」与「数据权限矩阵」两个模块，详情见通知公告页。', 1, '/plugins/notice', null, now(), null, 0, null),
(4000000000000000083, '你的账号资料待完善', '这条是只发给 admin 的定向通知示例——其他账号看不到它。', 0, '/profile', 2048601269672738816, now(), null, 0, null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2240000000000000001, '消息推送', 'NotifyCenter', '/notify', 11, 'mdi:bell-cog-outline', 0, null, 1, 1, '', null, null, now(), null),
(2240000000000000002, '通知策略', 'NotifyPolicy', '/notify/policy', 1, 'mdi:tune-variant', 1, null, 1, 1, '', null, 2240000000000000001, now(), null),
(2240000000000000003, '投递记录', 'NotifyDelivery', '/notify/delivery', 2, 'mdi:send-check-outline', 1, null, 1, 1, '', null, 2240000000000000001, now(), null),
(2240000000000000004, '查询', 'QueryNotifyPolicy', null, 0, null, 2, 'sys:notification:policy:list', 1, 0, '', null, 2240000000000000002, now(), null),
(2240000000000000005, '修改', 'EditNotifyPolicy', null, 1, null, 2, 'sys:notification:policy:edit', 1, 0, '', null, 2240000000000000002, now(), null),
(2240000000000000006, '查询', 'QueryNotifyDelivery', null, 0, null, 2, 'sys:notification:delivery:list', 1, 0, '', null, 2240000000000000003, now(), null),
(2240000000000000007, '重发', 'ResendNotifyDelivery', null, 1, null, 2, 'sys:notification:delivery:resend', 1, 0, '', null, 2240000000000000003, now(), null);

insert into task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
values (2240000000000000101, '通知投递', 'notification.deliver_pending', null, null, null, null, null, null, null, 60, 0, 15, 'seconds', '* * * * *', false, true, 0, null, '每 15 秒把到点的通知邮件 / 短信发出去（安全网：写了投递的事务提交后也会立刻踢一次）。停用后投递行会一直停在「待发」', now(), null, 0, null);
