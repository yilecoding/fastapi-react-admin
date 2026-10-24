insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2230000000000000001, '短信', 'Sms', '/sms', 10, 'mdi:message-text-outline', 0, null, 1, 1, '', null, null, now(), null),
(2230000000000000002, '短信配置', 'SmsConfig', '/sms/config', 1, 'mdi:cellphone-message', 1, null, 1, 1, '', null, 2230000000000000001, now(), null),
(2230000000000000003, '发送日志', 'SmsLog', '/sms/log', 2, 'mdi:message-badge-outline', 1, null, 1, 1, '', null, 2230000000000000001, now(), null),
(2230000000000000004, '查询', 'QuerySmsConfig', null, 0, null, 2, 'sms:config:list', 1, 0, '', null, 2230000000000000002, now(), null),
(2230000000000000005, '新增', 'AddSmsConfig', null, 1, null, 2, 'sms:config:add', 1, 0, '', null, 2230000000000000002, now(), null),
(2230000000000000006, '修改', 'EditSmsConfig', null, 2, null, 2, 'sms:config:edit', 1, 0, '', null, 2230000000000000002, now(), null),
(2230000000000000007, '删除', 'DeleteSmsConfig', null, 3, null, 2, 'sms:config:del', 1, 0, '', null, 2230000000000000002, now(), null),
(2230000000000000008, '发测试短信', 'TestSmsConfig', null, 4, null, 2, 'sms:config:test', 1, 0, '', null, 2230000000000000002, now(), null),
(2230000000000000009, '查询', 'QuerySmsLog', null, 0, null, 2, 'sms:log:list', 1, 0, '', null, 2230000000000000003, now(), null),
(2230000000000000010, '删除', 'DeleteSmsLog', null, 1, null, 2, 'sms:log:del', 1, 0, '', null, 2230000000000000003, now(), null);
