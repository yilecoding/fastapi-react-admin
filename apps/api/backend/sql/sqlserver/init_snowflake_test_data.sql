INSERT INTO sys_dept (id, code, name, sort, leader, phone, email, status, deleted, parent_id, created_time, updated_time)
VALUES (2048601258595581952, N'TEST', N'测试', 0, NULL, NULL, NULL, 1, 0, NULL, GETDATE(), NULL);

INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2049629108245233664, N'仪表盘', 'Dashboard', '/dashboard', 0, 'ant-design:dashboard-outlined', 1, NULL, 1, 1, '', NULL, NULL, '2025-06-26 20:29:06', NULL),
(2049629108245233667, N'系统管理', 'System', '/system', 1, 'eos-icons:admin', 0, NULL, 1, 1, '', NULL, NULL, '2025-06-26 20:29:06', NULL),
(2049629108245233668, N'部门管理', 'SysDept', '/system/dept', 1, 'mingcute:department-line', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108245233669, N'新增', 'AddSysDept', NULL, 0, NULL, 2, 'sys:dept:add', 1, 0, '', NULL, 2049629108245233668, '2025-06-26 20:29:06', NULL),
(2049629108245233670, N'修改', 'EditSysDept', NULL, 0, NULL, 2, 'sys:dept:edit', 1, 0, '', NULL, 2049629108245233668, '2025-06-26 20:29:06', NULL),
(2049629108245233671, N'删除', 'DeleteSysDept', NULL, 0, NULL, 2, 'sys:dept:del', 1, 0, '', NULL, 2049629108245233668, '2025-06-26 20:29:06', NULL),
(2049629108245233672, N'用户管理', 'SysUser', '/system/user', 2, 'ant-design:user-outlined', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108245233673, N'删除', 'DeleteSysUser', NULL, 0, NULL, 2, 'sys:user:del', 1, 0, '', NULL, 2049629108245233672, '2025-06-26 20:29:06', NULL),
(2049629108245233674, N'角色管理', 'SysRole', '/system/role', 3, 'carbon:user-role', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108245233675, N'新增', 'AddSysRole', NULL, 0, NULL, 2, 'sys:role:add', 1, 0, '', NULL, 2049629108245233674, '2025-06-26 20:29:06', NULL),
(2049629108245233676, N'修改', 'EditSysRole', NULL, 0, NULL, 2, 'sys:role:edit', 1, 0, '', NULL, 2049629108245233674, '2025-06-26 20:29:06', NULL),
(2049629108245233677, N'修改角色菜单', 'EditSysRoleMenu', NULL, 0, NULL, 2, 'sys:role:menu:edit', 1, 0, '', NULL, 2049629108245233674, '2025-06-26 20:29:06', NULL),
(2049629108245233678, N'修改角色数据范围', 'EditSysRoleScope', NULL, 0, NULL, 2, 'sys:role:scope:edit', 1, 0, '', NULL, 2049629108245233674, '2025-06-26 20:29:06', NULL),
(2049629108245233679, N'删除', 'DeleteSysRole', NULL, 0, NULL, 2, 'sys:role:del', 1, 0, '', NULL, 2049629108245233674, '2025-06-26 20:29:06', NULL),
(2049629108245233680, N'菜单管理', 'SysMenu', '/system/menu', 4, 'ant-design:menu-outlined', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108245233681, N'新增', 'AddSysMenu', NULL, 0, NULL, 2, 'sys:menu:add', 1, 0, '', NULL, 2049629108245233680, '2025-06-26 20:29:06', NULL),
(2049629108245233682, N'修改', 'EditSysMenu', NULL, 0, NULL, 2, 'sys:menu:edit', 1, 0, '', NULL, 2049629108245233680, '2025-06-26 20:29:06', NULL),
(2049629108249427968, N'删除', 'DeleteSysMenu', NULL, 0, NULL, 2, 'sys:menu:del', 1, 0, '', NULL, 2049629108245233680, '2025-06-26 20:29:06', NULL),
(2049629108249427969, N'数据权限', 'SysDataPermission', '/system/data-permission', 5, 'icon-park-outline:permissions', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108249427971, N'新增范围', 'AddSysDataScope', NULL, 0, NULL, 2, 'data:scope:add', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427972, N'修改范围', 'EditSysDataScope', NULL, 0, NULL, 2, 'data:scope:edit', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427973, N'修改范围规则', 'EditDataScopeRule', NULL, 0, NULL, 2, 'data:scope:rule:edit', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427974, N'删除范围', 'DeleteSysDataScope', NULL, 0, NULL, 2, 'data:scope:del', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427976, N'新增规则', 'AddSysDataRule', NULL, 0, NULL, 2, 'data:rule:add', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427977, N'修改规则', 'EditSysDataRule', NULL, 0, NULL, 2, 'data:rule:edit', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427978, N'删除规则', 'DeleteSysDataRule', NULL, 0, NULL, 2, 'data:rule:del', 1, 0, '', NULL, 2049629108249427969, '2025-06-26 20:29:06', NULL),
(2049629108249427979, N'插件管理', 'SysPlugin', '/system/plugin', 10, 'clarity:plugin-line', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108249427983, N'日志管理', 'Log', '/log', 3, 'carbon:cloud-logging', 0, NULL, 1, 1, '', NULL, NULL, '2025-06-26 20:29:06', NULL),
(2049629108249427984, N'登录日志', 'LoginLog', '/log/login', 1, 'mdi:login', 1, NULL, 1, 1, '', NULL, 2049629108249427983, '2025-06-26 20:29:06', NULL),
(2049629108249427985, N'删除', 'DeleteLoginLog', NULL, 0, NULL, 2, 'log:login:del', 1, 0, '', NULL, 2049629108249427984, '2025-06-26 20:29:06', NULL),
(2049629108249427986, N'清空', 'EmptyLoginLog', NULL, 0, NULL, 2, 'log:login:clear', 1, 0, '', NULL, 2049629108249427984, '2025-06-26 20:29:06', NULL),
(2049629108249427987, N'操作日志', 'OperaLog', '/log/opera', 2, 'carbon:operations-record', 1, NULL, 1, 1, '', NULL, 2049629108249427983, '2025-06-26 20:29:06', NULL),
(2049629108249427988, N'删除', 'DeleteOperaLog', NULL, 0, NULL, 2, 'log:opera:del', 1, 0, '', NULL, 2049629108249427987, '2025-06-26 20:29:06', NULL),
(2049629108253622272, N'清空', 'EmptyOperaLog', NULL, 0, NULL, 2, 'log:opera:clear', 1, 0, '', NULL, 2049629108249427987, '2025-06-26 20:29:06', NULL),
(2049629108253622273, N'系统监控', 'Monitor', '/monitor', 4, 'mdi:monitor-eye', 0, NULL, 1, 1, '', NULL, NULL, '2025-06-26 20:29:06', NULL),
(2049629108253622274, N'在线用户', 'Online', '/monitor/online', 1, 'wpf:online', 1, NULL, 1, 1, '', NULL, 2049629108253622273, '2025-06-26 20:29:06', NULL),
(2049629108253622276, N'Redis 监控', 'Redis', '/monitor/redis', 2, 'devicon:redis', 1, NULL, 1, 1, '', NULL, 2049629108253622273, '2025-06-26 20:29:06', NULL),
(2049629108253622277, N'服务器监控', 'Server', '/monitor/server', 3, 'mdi:server-outline', 1, NULL, 1, 1, '', NULL, 2049629108253622273, '2025-06-26 20:29:06', NULL),
(2049629108253622282, N'个人中心', 'Profile', '/profile', 6, 'ant-design:profile-outlined', 1, NULL, 1, 0, '', NULL, NULL, '2025-06-26 20:29:06', NULL),
(2049629108253622300, N'文件管理', 'SysFile', '/system/file', 6, 'lucide:files', 1, NULL, 1, 1, '', NULL, 2049629108245233667, '2025-06-26 20:29:06', NULL),
(2049629108253622301, N'查询', 'QuerySysFile', NULL, 0, NULL, 2, 'sys:file:list', 1, 0, '', NULL, 2049629108253622300, '2025-06-26 20:29:06', NULL),
(2049629108253622302, N'上传', 'UploadSysFile', NULL, 0, NULL, 2, 'sys:file:upload', 1, 0, '', NULL, 2049629108253622300, '2025-06-26 20:29:06', NULL),
(2049629108253622303, N'删除', 'DeleteSysFile', NULL, 0, NULL, 2, 'sys:file:del', 1, 0, '', NULL, 2049629108253622300, '2025-06-26 20:29:06', NULL);

INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2049629108253622310, N'定时任务', 'Scheduler', '/scheduler', 5, 'ix:scheduler', 0, NULL, 1, 1, '', NULL, NULL, '2026-08-22 17:00:00', NULL),
(2049629108253622311, N'任务调度', 'SchedulerManage', '/scheduler/manage', 1, 'mdi:clock-outline', 1, NULL, 1, 1, '', NULL, 2049629108253622310, '2026-08-22 17:00:00', NULL),
(2049629108253622312, N'执行记录', 'SchedulerRecord', '/scheduler/record', 2, 'mdi:history', 1, NULL, 1, 1, '', NULL, 2049629108253622310, '2026-08-22 17:00:00', NULL),
(2049629108253622313, N'新增', 'AddTaskScheduler', NULL, 0, NULL, 2, 'task:scheduler:add', 1, 0, '', NULL, 2049629108253622311, '2026-08-22 17:00:00', NULL),
(2049629108253622314, N'修改', 'EditTaskScheduler', NULL, 1, NULL, 2, 'task:scheduler:edit', 1, 0, '', NULL, 2049629108253622311, '2026-08-22 17:00:00', NULL),
(2049629108253622315, N'删除', 'DeleteTaskScheduler', NULL, 2, NULL, 2, 'task:scheduler:del', 1, 0, '', NULL, 2049629108253622311, '2026-08-22 17:00:00', NULL),
(2049629108253622316, N'执行', 'RunTaskScheduler', NULL, 3, NULL, 2, 'task:scheduler:run', 1, 0, '', NULL, 2049629108253622311, '2026-08-22 17:00:00', NULL),
(2049629108253622317, N'删除', 'DeleteTaskResult', NULL, 0, NULL, 2, 'task:result:del', 1, 0, '', NULL, 2049629108253622312, '2026-08-22 17:00:00', NULL);

INSERT INTO task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
VALUES
(2049629108253622320, N'清理历史日志', 'maintenance.prune_logs', NULL, N'{"days": 30}', NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, '15 3 * * *', 0, 1, 0, NULL, N'保留 30 天。日志表是全库长得最快的表，不清理会一直涨', '2026-08-22 17:00:00', NULL, 0, NULL),
(2049629108253622321, N'清理任务执行记录', 'maintenance.prune_task_results', NULL, N'{"days": 30}', NULL, NULL, NULL, NULL, NULL, NULL, 1, NULL, NULL, '30 3 * * *', 0, 1, 0, NULL, N'保留 30 天。celery 自带的 backend_cleanup 不会被装上（DatabaseScheduler 重写了 setup_schedule），必须自己排', '2026-08-22 17:00:00', NULL, 0, NULL);

INSERT INTO sys_role (id, code, name, status, is_filter_scopes, remark, created_time, updated_time)
VALUES (2048601263515500544, N'TEST', N'测试', 1, 1, NULL, GETDATE(), NULL);

INSERT INTO sys_role_menu (id, role_id, menu_id)
VALUES
(2048601263578415104, 2048601263515500544, 2049629108245233664),
(2048601263775547392, 2048601263515500544, 2049629108253622282);

INSERT INTO sys_user (id, uuid, username, nickname, password, salt, email, status, is_superuser, is_staff, is_multi_login, avatar, timezone, phone, join_time, last_login_time, last_password_changed_time, dept_id, created_time, updated_time)
VALUES
(2048601263834267648, CONVERT(varchar(36), NEWID()), 'admin', N'用户88888', '$2b$12$8y2eNucX19VjmZ3tYhBLcOsBwy9w1IjBQE4SSqwMDL5bGQVp2wqS.', 0x24326224313224387932654E7563583139566A6D5A33745968424C634F, 'admin@example.com', 1, 1, 1, 1, NULL, 'Asia/Shanghai', NULL, GETDATE(), GETDATE(), GETDATE(), 2048601258595581952, GETDATE(), NULL),
(2049946297615646720, CONVERT(varchar(36), NEWID()), 'test', N'用户66666', '$2b$12$BMiXsNQAgTx7aNc7kVgnwedXGyUxPEHRnJMFbiikbqHgVoT3y14Za', 0x24326224313224424D6958734E514167547837614E63376B56676E7765, 'test@example.com', 1, 0, 0, 0, NULL, 'Asia/Shanghai', NULL, GETDATE(), GETDATE(), GETDATE(), 2048601258595581952, GETDATE(), NULL);

INSERT INTO sys_user_role (id, user_id, role_id)
VALUES
(2048601263838461952, 2048601263834267648, 2048601263515500544),
(2049946493732913152, 2049946297615646720, 2048601263515500544);

INSERT INTO sys_data_scope (id, name, status, created_time, updated_time)
VALUES
(2048601263901376512, N'本部门数据权限', 1, GETDATE(), NULL),
(2048601263968485376, N'部门及以下数据权限', 1, GETDATE(), NULL),
(2048601263968485377, N'仅本人数据权限', 1, GETDATE(), NULL),
(2048601263968485378, N'全模型本部门数据权限', 1, GETDATE(), NULL),
(2048601263968485379, N'排除超级管理员数据权限', 1, GETDATE(), NULL);

INSERT INTO sys_data_rule (id, name, model, [column], operator, expression, [value], created_time, updated_time)
VALUES
(2048601264035594240, N'部门 ID 等于当前用户部门', 'Dept', '__dept_id__', 0, 0, '${dept_id}', GETDATE(), NULL),
(2048601264102703104, N'部门编码等于 TEST', 'Dept', 'code', 1, 0, 'TEST', GETDATE(), NULL),
(2048601264102703105, N'父部门 ID 等于测试部门 ID', 'Dept', 'parent_id', 0, 0, '2048601258595581952', GETDATE(), NULL),
(2048601264102703106, N'创建者等于当前用户', '__ALL__', '__created_by__', 0, 0, '${user_id}', GETDATE(), NULL),
(2048601264102703107, N'全模型部门 ID 等于当前用户部门', '__ALL__', '__dept_id__', 0, 0, '${dept_id}', GETDATE(), NULL),
(2048601264102703109, N'用户非超级管理员', 'User', 'is_superuser', 0, 1, '1', GETDATE(), NULL);

INSERT INTO sys_data_scope_rule (id, data_scope_id, data_rule_id)
VALUES
(2048601264169811968, 2048601263901376512, 2048601264035594240),
(2048601264236920832, 2048601263968485376, 2048601264102703104),
(2048601264299835392, 2048601263968485376, 2048601264102703105),
(2048601264299835393, 2048601263968485377, 2048601264102703106),
(2048601264299835394, 2048601263968485378, 2048601264102703107),
(2048601264299835395, 2048601263968485379, 2048601264102703109);
