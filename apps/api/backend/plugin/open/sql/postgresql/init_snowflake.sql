insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2220000000000000001, '能力开放', 'OpenPlatform', '/open', 9, 'mdi:api', 0, null, 1, 1, '', null, null, now(), null),
(2220000000000000002, '应用管理', 'OpenApp', '/open/app', 1, 'mdi:key-variant', 1, null, 1, 1, '', null, 2220000000000000001, now(), null),
(2220000000000000003, '查询', 'QueryOpenApp', null, 0, null, 2, 'open:app:list', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000004, '新增', 'AddOpenApp', null, 1, null, 2, 'open:app:add', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000005, '修改', 'EditOpenApp', null, 2, null, 2, 'open:app:edit', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000006, '重置密钥', 'ResetOpenAppSecret', null, 3, null, 2, 'open:app:reset', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000007, '删除', 'DeleteOpenApp', null, 4, null, 2, 'open:app:del', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000008, '调用日志', 'QueryOpenApiLog', null, 5, null, 2, 'open:log:list', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000009, 'Webhook 查询', 'QueryOpenWebhook', null, 6, null, 2, 'open:webhook:list', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000010, 'Webhook 新增', 'AddOpenWebhook', null, 7, null, 2, 'open:webhook:add', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000011, 'Webhook 修改', 'EditOpenWebhook', null, 8, null, 2, 'open:webhook:edit', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000012, 'Webhook 删除', 'DeleteOpenWebhook', null, 9, null, 2, 'open:webhook:del', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000013, 'Webhook 重置密钥', 'ResetOpenWebhookSecret', null, 10, null, 2, 'open:webhook:reset', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000014, 'Webhook 发测试', 'TestOpenWebhook', null, 11, null, 2, 'open:webhook:test', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000015, 'Webhook 重发', 'ResendOpenWebhook', null, 12, null, 2, 'open:webhook:resend', 1, 0, '', null, 2220000000000000002, now(), null);

insert into task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
values (2220000000000000101, 'Webhook 投递', 'open.webhook_deliver_pending', null, null, null, null, null, null, null, 60, 0, 15, 'seconds', '* * * * *', false, true, 0, null, '每 15 秒把到点的 Webhook 事件签名 POST 给对接方（安全网：写了投递的事务提交后也会立刻踢一次）。停用后投递会一直停在「待发」', now(), null, 0, null);
