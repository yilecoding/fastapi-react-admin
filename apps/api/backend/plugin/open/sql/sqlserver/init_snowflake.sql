INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2220000000000000001, N'能力开放', 'OpenPlatform', '/open', 9, 'mdi:api', 0, NULL, 1, 1, '', NULL, NULL, GETDATE(), NULL),
(2220000000000000002, N'应用管理', 'OpenApp', '/open/app', 1, 'mdi:key-variant', 1, NULL, 1, 1, '', NULL, 2220000000000000001, GETDATE(), NULL),
(2220000000000000003, N'查询', 'QueryOpenApp', NULL, 0, NULL, 2, 'open:app:list', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000004, N'新增', 'AddOpenApp', NULL, 1, NULL, 2, 'open:app:add', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000005, N'修改', 'EditOpenApp', NULL, 2, NULL, 2, 'open:app:edit', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000006, N'重置密钥', 'ResetOpenAppSecret', NULL, 3, NULL, 2, 'open:app:reset', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000007, N'删除', 'DeleteOpenApp', NULL, 4, NULL, 2, 'open:app:del', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL),
(2220000000000000008, N'调用日志', 'QueryOpenApiLog', NULL, 5, NULL, 2, 'open:log:list', 1, 0, '', NULL, 2220000000000000002, GETDATE(), NULL);
