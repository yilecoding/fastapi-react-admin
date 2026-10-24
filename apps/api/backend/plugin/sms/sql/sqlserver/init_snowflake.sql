INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2230000000000000001, N'短信', 'Sms', '/sms', 10, 'mdi:message-text-outline', 0, NULL, 1, 1, '', NULL, NULL, GETDATE(), NULL),
(2230000000000000002, N'短信配置', 'SmsConfig', '/sms/config', 1, 'mdi:cellphone-message', 1, NULL, 1, 1, '', NULL, 2230000000000000001, GETDATE(), NULL),
(2230000000000000003, N'发送日志', 'SmsLog', '/sms/log', 2, 'mdi:message-badge-outline', 1, NULL, 1, 1, '', NULL, 2230000000000000001, GETDATE(), NULL),
(2230000000000000004, N'查询', 'QuerySmsConfig', NULL, 0, NULL, 2, 'sms:config:list', 1, 0, '', NULL, 2230000000000000002, GETDATE(), NULL),
(2230000000000000005, N'新增', 'AddSmsConfig', NULL, 1, NULL, 2, 'sms:config:add', 1, 0, '', NULL, 2230000000000000002, GETDATE(), NULL),
(2230000000000000006, N'修改', 'EditSmsConfig', NULL, 2, NULL, 2, 'sms:config:edit', 1, 0, '', NULL, 2230000000000000002, GETDATE(), NULL),
(2230000000000000007, N'删除', 'DeleteSmsConfig', NULL, 3, NULL, 2, 'sms:config:del', 1, 0, '', NULL, 2230000000000000002, GETDATE(), NULL),
(2230000000000000008, N'发测试短信', 'TestSmsConfig', NULL, 4, NULL, 2, 'sms:config:test', 1, 0, '', NULL, 2230000000000000002, GETDATE(), NULL),
(2230000000000000009, N'查询', 'QuerySmsLog', NULL, 0, NULL, 2, 'sms:log:list', 1, 0, '', NULL, 2230000000000000003, GETDATE(), NULL),
(2230000000000000010, N'删除', 'DeleteSmsLog', NULL, 1, NULL, 2, 'sms:log:del', 1, 0, '', NULL, 2230000000000000003, GETDATE(), NULL);
