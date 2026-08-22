insert into sys_dept (id, code, name, sort, leader, phone, email, status, deleted, parent_id, created_time, updated_time)
values (2048601264366944256, 'TEST', '测试', 0, null, null, null, 1, 0, null, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2049629108245233664, '仪表盘', 'Dashboard', '/dashboard', 0, 'ant-design:dashboard-outlined', 1, null, 1, 1, '', null, null, '2025-06-26 20:29:06', null),
(2049629108245233667, '系统管理', 'System', '/system', 1, 'eos-icons:admin', 0, null, 1, 1, '', null, null, '2025-06-26 20:29:06', null),
(2049629108245233668, '部门管理', 'SysDept', '/system/dept', 1, 'mingcute:department-line', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108245233669, '新增', 'AddSysDept', null, 0, null, 2, 'sys:dept:add', 1, 0, '', null, 2049629108245233668, '2025-06-26 20:29:06', null),
(2049629108245233670, '修改', 'EditSysDept', null, 0, null, 2, 'sys:dept:edit', 1, 0, '', null, 2049629108245233668, '2025-06-26 20:29:06', null),
(2049629108245233671, '删除', 'DeleteSysDept', null, 0, null, 2, 'sys:dept:del', 1, 0, '', null, 2049629108245233668, '2025-06-26 20:29:06', null),
(2049629108245233672, '用户管理', 'SysUser', '/system/user', 2, 'ant-design:user-outlined', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108245233673, '删除', 'DeleteSysUser', null, 0, null, 2, 'sys:user:del', 1, 0, '', null, 2049629108245233672, '2025-06-26 20:29:06', null),
(2049629108245233674, '角色管理', 'SysRole', '/system/role', 3, 'carbon:user-role', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108245233675, '新增', 'AddSysRole', null, 0, null, 2, 'sys:role:add', 1, 0, '', null, 2049629108245233674, '2025-06-26 20:29:06', null),
(2049629108245233676, '修改', 'EditSysRole', null, 0, null, 2, 'sys:role:edit', 1, 0, '', null, 2049629108245233674, '2025-06-26 20:29:06', null),
(2049629108245233677, '修改角色菜单', 'EditSysRoleMenu', null, 0, null, 2, 'sys:role:menu:edit', 1, 0, '', null, 2049629108245233674, '2025-06-26 20:29:06', null),
(2049629108245233678, '修改角色数据范围', 'EditSysRoleScope', null, 0, null, 2, 'sys:role:scope:edit', 1, 0, '', null, 2049629108245233674, '2025-06-26 20:29:06', null),
(2049629108245233679, '删除', 'DeleteSysRole', null, 0, null, 2, 'sys:role:del', 1, 0, '', null, 2049629108245233674, '2025-06-26 20:29:06', null),
(2049629108245233680, '菜单管理', 'SysMenu', '/system/menu', 4, 'ant-design:menu-outlined', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108245233681, '新增', 'AddSysMenu', null, 0, null, 2, 'sys:menu:add', 1, 0, '', null, 2049629108245233680, '2025-06-26 20:29:06', null),
(2049629108245233682, '修改', 'EditSysMenu', null, 0, null, 2, 'sys:menu:edit', 1, 0, '', null, 2049629108245233680, '2025-06-26 20:29:06', null),
(2049629108249427968, '删除', 'DeleteSysMenu', null, 0, null, 2, 'sys:menu:del', 1, 0, '', null, 2049629108245233680, '2025-06-26 20:29:06', null),
(2049629108249427969, '数据权限', 'SysDataPermission', '/system/data-permission', 5, 'icon-park-outline:permissions', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108249427971, '新增范围', 'AddSysDataScope', null, 0, null, 2, 'data:scope:add', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427972, '修改范围', 'EditSysDataScope', null, 0, null, 2, 'data:scope:edit', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427973, '修改范围规则', 'EditDataScopeRule', null, 0, null, 2, 'data:scope:rule:edit', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427974, '删除范围', 'DeleteSysDataScope', null, 0, null, 2, 'data:scope:del', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427976, '新增规则', 'AddSysDataRule', null, 0, null, 2, 'data:rule:add', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427977, '修改规则', 'EditSysDataRule', null, 0, null, 2, 'data:rule:edit', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427978, '删除规则', 'DeleteSysDataRule', null, 0, null, 2, 'data:rule:del', 1, 0, '', null, 2049629108249427969, '2025-06-26 20:29:06', null),
(2049629108249427979, '插件管理', 'SysPlugin', '/system/plugin', 10, 'clarity:plugin-line', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108249427983, '日志管理', 'Log', '/log', 3, 'carbon:cloud-logging', 0, null, 1, 1, '', null, null, '2025-06-26 20:29:06', null),
(2049629108249427984, '登录日志', 'LoginLog', '/log/login', 1, 'mdi:login', 1, null, 1, 1, '', null, 2049629108249427983, '2025-06-26 20:29:06', null),
(2049629108249427985, '删除', 'DeleteLoginLog', null, 0, null, 2, 'log:login:del', 1, 0, '', null, 2049629108249427984, '2025-06-26 20:29:06', null),
(2049629108249427986, '清空', 'EmptyLoginLog', null, 0, null, 2, 'log:login:clear', 1, 0, '', null, 2049629108249427984, '2025-06-26 20:29:06', null),
(2049629108249427987, '操作日志', 'OperaLog', '/log/opera', 2, 'carbon:operations-record', 1, null, 1, 1, '', null, 2049629108249427983, '2025-06-26 20:29:06', null),
(2049629108249427988, '删除', 'DeleteOperaLog', null, 0, null, 2, 'log:opera:del', 1, 0, '', null, 2049629108249427987, '2025-06-26 20:29:06', null),
(2049629108253622272, '清空', 'EmptyOperaLog', null, 0, null, 2, 'log:opera:clear', 1, 0, '', null, 2049629108249427987, '2025-06-26 20:29:06', null),
(2049629108253622273, '系统监控', 'Monitor', '/monitor', 4, 'mdi:monitor-eye', 0, null, 1, 1, '', null, null, '2025-06-26 20:29:06', null),
(2049629108253622274, '在线用户', 'Online', '/monitor/online', 1, 'wpf:online', 1, null, 1, 1, '', null, 2049629108253622273, '2025-06-26 20:29:06', null),
(2049629108253622276, 'Redis 监控', 'Redis', '/monitor/redis', 2, 'devicon:redis', 1, null, 1, 1, '', null, 2049629108253622273, '2025-06-26 20:29:06', null),
(2049629108253622277, '服务器监控', 'Server', '/monitor/server', 3, 'mdi:server-outline', 1, null, 1, 1, '', null, 2049629108253622273, '2025-06-26 20:29:06', null),
(2049629108253622282, '个人中心', 'Profile', '/profile', 6, 'ant-design:profile-outlined', 1, null, 1, 0, '', null, null, '2025-06-26 20:29:06', null),
(2049629108253622300, '文件管理', 'SysFile', '/system/file', 6, 'lucide:files', 1, null, 1, 1, '', null, 2049629108245233667, '2025-06-26 20:29:06', null),
(2049629108253622301, '查询', 'QuerySysFile', null, 0, null, 2, 'sys:file:list', 1, 0, '', null, 2049629108253622300, '2025-06-26 20:29:06', null),
(2049629108253622302, '上传', 'UploadSysFile', null, 0, null, 2, 'sys:file:upload', 1, 0, '', null, 2049629108253622300, '2025-06-26 20:29:06', null),
(2049629108253622303, '删除', 'DeleteSysFile', null, 0, null, 2, 'sys:file:del', 1, 0, '', null, 2049629108253622300, '2025-06-26 20:29:06', null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2049629108253622310, '定时任务', 'Scheduler', '/scheduler', 5, 'ix:scheduler', 0, null, 1, 1, '', null, null, '2026-08-22 17:00:00', null),
(2049629108253622311, '任务调度', 'SchedulerManage', '/scheduler/manage', 1, 'mdi:clock-outline', 1, null, 1, 1, '', null, 2049629108253622310, '2026-08-22 17:00:00', null),
(2049629108253622312, '执行记录', 'SchedulerRecord', '/scheduler/record', 2, 'mdi:history', 1, null, 1, 1, '', null, 2049629108253622310, '2026-08-22 17:00:00', null),
(2049629108253622313, '新增', 'AddTaskScheduler', null, 0, null, 2, 'task:scheduler:add', 1, 0, '', null, 2049629108253622311, '2026-08-22 17:00:00', null),
(2049629108253622314, '修改', 'EditTaskScheduler', null, 1, null, 2, 'task:scheduler:edit', 1, 0, '', null, 2049629108253622311, '2026-08-22 17:00:00', null),
(2049629108253622315, '删除', 'DeleteTaskScheduler', null, 2, null, 2, 'task:scheduler:del', 1, 0, '', null, 2049629108253622311, '2026-08-22 17:00:00', null),
(2049629108253622316, '执行', 'RunTaskScheduler', null, 3, null, 2, 'task:scheduler:run', 1, 0, '', null, 2049629108253622311, '2026-08-22 17:00:00', null),
(2049629108253622317, '删除', 'DeleteTaskResult', null, 0, null, 2, 'task:result:del', 1, 0, '', null, 2049629108253622312, '2026-08-22 17:00:00', null);

insert into task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
values
(2049629108253622320, '清理历史日志', 'maintenance.prune_logs', null, '{"days": 30}', null, null, null, null, null, null, 1, null, null, '15 3 * * *', 0, 1, 0, null, '保留 30 天。日志表是全库长得最快的表，不清理会一直涨', '2026-08-22 17:00:00', null, 0, null),
(2049629108253622321, '清理任务执行记录', 'maintenance.prune_task_results', null, '{"days": 30}', null, null, null, null, null, null, 1, null, null, '30 3 * * *', 0, 1, 0, null, '保留 30 天。celery 自带的 backend_cleanup 不会被装上（DatabaseScheduler 重写了 setup_schedule），必须自己排', '2026-08-22 17:00:00', null, 0, null);

insert into sys_role (id, code, name, status, is_filter_scopes, remark, created_time, updated_time)
values (2048601269345583104, 'TEST', '测试', 1, true, null, now(), null);

insert into sys_role_menu (id, role_id, menu_id)
values
(2048601269412691968, 2048601269345583104, 2049629108245233664),
(2048601269609824256, 2048601269345583104, 2049629108253622282);

insert into sys_user (id, uuid, username, nickname, password, salt, email, status, is_superuser, is_staff, is_multi_login, avatar, timezone, phone, join_time, last_login_time, last_password_changed_time, dept_id, created_time, updated_time)
values
(2048601269672738816, gen_random_uuid(), 'admin', '用户88888', '$2b$12$8y2eNucX19VjmZ3tYhBLcOsBwy9w1IjBQE4SSqwMDL5bGQVp2wqS.', decode('24326224313224387932654E7563583139566A6D5A33745968424C634F', 'hex'), 'admin@example.com', 1, true, true, true, null, 'Asia/Shanghai', null, now(), now(), now(), 2048601264366944256, now(), null),
(2049946297615646720, gen_random_uuid(), 'test', '用户66666', '$2b$12$BMiXsNQAgTx7aNc7kVgnwedXGyUxPEHRnJMFbiikbqHgVoT3y14Za', decode('24326224313224424D6958734E514167547837614E63376B56676E7765', 'hex'), 'test@example.com', 1, false, false, false, null, 'Asia/Shanghai', null, now(), now(), now(), 2048601264366944256, now(), null);

insert into sys_user_role (id, user_id, role_id)
values
(2048601269739847680, 2048601269672738816, 2048601269345583104),
(2049946493732913152, 2049946297615646720, 2048601269345583104);

insert into sys_data_scope (id, name, status, created_time, updated_time)
values
(2048601269806956544, '本部门数据权限', 1, now(), null),
(2048601269869871104, '部门及以下数据权限', 1, now(), null),
(2048601269869871105, '仅本人数据权限', 1, now(), null),
(2048601269869871106, '全模型本部门数据权限', 1, now(), null),
(2048601269869871107, '排除超级管理员数据权限', 1, now(), null);

insert into sys_data_rule (id, name, model, "column", operator, expression, "value", created_time, updated_time)
values
(2048601269932785664, '部门 ID 等于当前用户部门', 'Dept', '__dept_id__', 0, 0, '${dept_id}', now(), null),
(2048601269999894528, '部门编码等于 TEST', 'Dept', 'code', 1, 0, 'TEST', now(), null),
(2048601269999894529, '父部门 ID 等于测试部门 ID', 'Dept', 'parent_id', 0, 0, '2048601264366944256', now(), null),
(2048601269999894530, '创建者等于当前用户', '__ALL__', '__created_by__', 0, 0, '${user_id}', now(), null),
(2048601269999894531, '全模型部门 ID 等于当前用户部门', '__ALL__', '__dept_id__', 0, 0, '${dept_id}', now(), null),
(2048601269999894533, '用户非超级管理员', 'User', 'is_superuser', 0, 1, '1', now(), null);

insert into sys_data_scope_rule (id, data_scope_id, data_rule_id)
values
(2048601270062809088, 2048601269806956544, 2048601269932785664),
(2048601270125723648, 2048601269869871104, 2048601269999894528),
(2048601270192832512, 2048601269869871104, 2048601269999894529),
(2048601270192832513, 2048601269869871105, 2048601269999894530),
(2048601270192832514, 2048601269869871106, 2048601269999894531),
(2048601270192832515, 2048601269869871107, 2048601269999894533);
