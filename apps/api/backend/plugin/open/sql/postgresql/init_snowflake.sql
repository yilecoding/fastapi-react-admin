insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2220000000000000001, '能力开放', 'OpenPlatform', '/open', 9, 'mdi:api', 0, null, 1, 1, '', null, null, now(), null),
(2220000000000000002, '应用管理', 'OpenApp', '/open/app', 1, 'mdi:key-variant', 1, null, 1, 1, '', null, 2220000000000000001, now(), null),
(2220000000000000003, '查询', 'QueryOpenApp', null, 0, null, 2, 'open:app:list', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000004, '新增', 'AddOpenApp', null, 1, null, 2, 'open:app:add', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000005, '修改', 'EditOpenApp', null, 2, null, 2, 'open:app:edit', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000006, '重置密钥', 'ResetOpenAppSecret', null, 3, null, 2, 'open:app:reset', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000007, '删除', 'DeleteOpenApp', null, 4, null, 2, 'open:app:del', 1, 0, '', null, 2220000000000000002, now(), null),
(2220000000000000008, '调用日志', 'QueryOpenApiLog', null, 5, null, 2, 'open:log:list', 1, 0, '', null, 2220000000000000002, now(), null);
