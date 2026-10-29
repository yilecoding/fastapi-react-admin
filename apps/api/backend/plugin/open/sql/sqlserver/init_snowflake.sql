INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2220000000000000001, N'能力开放', 'OpenPlatform', '/open', 9, 'mdi:api', 0, NULL, 1, 1, '', NULL, NULL, GETDATE(), NULL),
(2220000000000000002, N'应用管理', 'OpenApp', '/open/app', 1, 'mdi:key-variant', 1, NULL, 1, 1, '', NULL, 2220000000000000001, GETDATE(), NULL),
(2220000000000000003, N'查询', 'QueryOpenApp', NULL, 0, NULL, 2, 'open:app:list', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000004, N'新增', 'AddOpenApp', NULL, 1, NULL, 2, 'open:app:add', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000005, N'修改', 'EditOpenApp', NULL, 2, NULL, 2, 'open:app:edit', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000006, N'重置密钥', 'ResetOpenAppSecret', NULL, 3, NULL, 2, 'open:app:reset', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000007, N'删除', 'DeleteOpenApp', NULL, 4, NULL, 2, 'open:app:del', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000008, N'调用日志', 'QueryOpenApiLog', NULL, 5, NULL, 2, 'open:log:list', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000009, N'Webhook 查询', 'QueryOpenWebhook', NULL, 6, NULL, 2, 'open:webhook:list', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000010, N'Webhook 新增', 'AddOpenWebhook', NULL, 7, NULL, 2, 'open:webhook:add', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000011, N'Webhook 修改', 'EditOpenWebhook', NULL, 8, NULL, 2, 'open:webhook:edit', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000012, N'Webhook 删除', 'DeleteOpenWebhook', NULL, 9, NULL, 2, 'open:webhook:del', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000013, N'Webhook 重置密钥', 'ResetOpenWebhookSecret', NULL, 10, NULL, 2, 'open:webhook:reset', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000014, N'Webhook 发测试', 'TestOpenWebhook', NULL, 11, NULL, 2, 'open:webhook:test', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000015, N'Webhook 重发', 'ResendOpenWebhook', NULL, 12, NULL, 2, 'open:webhook:resend', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL);

INSERT INTO task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
VALUES (2220000000000000101, N'Webhook 投递', 'open.webhook_deliver_pending', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 60, 0, 15, 'seconds', '* * * * *', 0, 1, 0, NULL, N'每 15 秒把到点的 Webhook 事件签名 POST 给对接方（安全网：写了投递的事务提交后也会立刻踢一次）。停用后投递会一直停在「待发」', GETDATE(), NULL, 0, NULL);
