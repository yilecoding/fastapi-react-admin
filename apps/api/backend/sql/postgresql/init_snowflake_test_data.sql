insert into sys_dept (id, code, name, sort, leader, phone, email, status, deleted, parent_id, created_time, updated_time)
values
(2048601264366944256, 'HQ', '总部', 0, null, null, null, 1, 0, null, now(), null),
(4000000000000000001, 'TECH', '技术中心', 1, '张伟', null, null, 1, 0, 2048601264366944256, now(), null),
(4000000000000000002, 'TECH_BE', '后端组', 1, '刘洋', null, null, 1, 0, 4000000000000000001, now(), null),
(4000000000000000003, 'TECH_FE', '前端组', 2, '陈静', null, null, 1, 0, 4000000000000000001, now(), null),
(4000000000000000004, 'PRODUCT', '产品设计中心', 2, '李娜', null, null, 1, 0, 2048601264366944256, now(), null),
(4000000000000000005, 'MARKETING', '市场运营中心', 3, '赵磊', null, null, 1, 0, 2048601264366944256, now(), null),
(4000000000000000006, 'FINANCE', '财务人事中心', 4, '王芳', null, null, 1, 0, 2048601264366944256, now(), null);

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
(2049629108253622320, '清理历史日志', 'maintenance.prune_logs', null, '{"days": 30}', null, null, null, null, null, null, 1, null, null, '15 3 * * *', false, true, 0, null, '保留 30 天。日志表是全库长得最快的表，不清理会一直涨', '2026-08-22 17:00:00', null, 0, null),
(2049629108253622321, '清理任务执行记录', 'maintenance.prune_task_results', null, '{"days": 30}', null, null, null, null, null, null, 1, null, null, '30 3 * * *', false, true, 0, null, '保留 30 天。celery 自带的 backend_cleanup 不会被装上（DatabaseScheduler 重写了 setup_schedule），必须自己排', '2026-08-22 17:00:00', null, 0, null),
(2049629108253622322, '每日问候', 'notification.send_daily_greeting', null, null, null, null, null, null, null, null, 1, null, null, '0 9 * * *', false, true, 0, null, '每天 9:00 给全员发一条随机问候语，顺带验收消息中心链路（落库/未读数/socket 推送/前端红点）是否通畅', '2026-08-22 17:00:00', null, 0, null);

insert into sys_role (id, code, name, status, is_filter_scopes, remark, created_time, updated_time)
values
(2048601269345583104, 'STAFF', '普通员工', 1, true, '基础角色，只看仪表盘和个人中心', now(), null),
(4000000000000000011, 'MANAGER', '部门经理', 1, true, '演示部门及以下数据权限用——能看本部门和下级部门的用户/部门列表', now(), null),
(4000000000000000012, 'FINANCE_STAFF', '财务专员', 1, true, '演示本部门数据权限用', now(), null),
(4000000000000000013, 'VIEWER', '只读访客', 1, true, '演示仅本人数据权限用——范围最窄的角色', now(), null);

insert into sys_role_menu (id, role_id, menu_id)
values
(2048601269412691968, 2048601269345583104, 2049629108245233664),
(2048601269609824256, 2048601269345583104, 2049629108253622282),
(4000000000000000021, 4000000000000000011, 2049629108245233664),
(4000000000000000022, 4000000000000000011, 2049629108253622282),
(4000000000000000023, 4000000000000000011, 2049629108245233668),
(4000000000000000024, 4000000000000000011, 2049629108245233672),
(4000000000000000025, 4000000000000000012, 2049629108245233664),
(4000000000000000026, 4000000000000000012, 2049629108253622282),
(4000000000000000027, 4000000000000000013, 2049629108245233664),
(4000000000000000028, 4000000000000000013, 2049629108253622282),
(4000000000000000061, 4000000000000000011, 2049629108253622330),
(4000000000000000062, 4000000000000000011, 2049629108253622337);

insert into sys_role_data_scope (id, role_id, data_scope_id)
values
(4000000000000000031, 4000000000000000011, 2048601269869871104),
(4000000000000000032, 4000000000000000012, 2048601269806956544),
(4000000000000000033, 4000000000000000013, 2048601269869871105);

insert into sys_user (id, uuid, username, nickname, password, salt, email, status, is_superuser, is_staff, is_multi_login, avatar, timezone, phone, join_time, last_login_time, last_password_changed_time, dept_id, created_time, updated_time)
values
(2048601269672738816, gen_random_uuid(), 'admin', '用户88888', '$2b$12$8y2eNucX19VjmZ3tYhBLcOsBwy9w1IjBQE4SSqwMDL5bGQVp2wqS.', decode('24326224313224387932654E7563583139566A6D5A33745968424C634F', 'hex'), 'admin@example.com', 1, true, true, true, null, 'Asia/Shanghai', null, now(), now(), now(), 2048601264366944256, now(), null),
(2049946297615646720, gen_random_uuid(), 'test', '用户66666', '$2b$12$BMiXsNQAgTx7aNc7kVgnwedXGyUxPEHRnJMFbiikbqHgVoT3y14Za', decode('24326224313224424D6958734E514167547837614E63376B56676E7765', 'hex'), 'test@example.com', 1, false, false, false, null, 'Asia/Shanghai', null, now(), now(), now(), 2048601264366944256, now(), null),
(4000000000000000041, gen_random_uuid(), 'zhangwei', '张伟', '$2b$12$Pnvhzs0e1pJ8qyvB9Kkv1em/IpT.46XKEfPqoIoLR2ly8RVCVEcLS', decode('506E76687A73306531704A3871797642394B6B763165', 'hex'), 'zhangwei@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000001, now(), null),
(4000000000000000042, gen_random_uuid(), 'lina', '李娜', '$2b$12$7xeTTK8azV4xXUGpZY7kBef7pfDj6ilVE1Pkt6VReNH5xd8kCgVEi', decode('37786554544B38617A563478585547705A59376B4265', 'hex'), 'lina@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000004, now(), null),
(4000000000000000043, gen_random_uuid(), 'wangfang', '王芳', '$2b$12$rCfJ7pCZp/CsGhfbBcU9YuXzfYb8xl8Xm7AqSG5u0fiyoetNGInQ.', decode('7243664A3770435A702F437347686662426355395975', 'hex'), 'wangfang@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000006, now(), null),
(4000000000000000044, gen_random_uuid(), 'liuyang', '刘洋', '$2b$12$z958muAw9wAclhvxw6tzROV8vIR2COsPdakXXv4d7QF7litw1Wdl6', decode('7A3935386D754177397741636C6876787736747A524F', 'hex'), 'liuyang@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000002, now(), null),
(4000000000000000045, gen_random_uuid(), 'chenjing', '陈静', '$2b$12$wqmNVS86davwAaQWMA/kL.P1nU4CV3HAeLcq0XdMBRSbsY5N/KIoa', decode('77716D4E5653383664617677416151574D412F6B4C2E', 'hex'), 'chenjing@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000003, now(), null),
(4000000000000000046, gen_random_uuid(), 'zhaolei', '赵磊', '$2b$12$aQ0gVSkO.pJi7iWXvx1UBujb9vnumYbTjhmoYlPgau/eo.t9oD0Pi', decode('6151306756536B4F2E704A6937695758767831554275', 'hex'), 'zhaolei@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000005, now(), null),
(4000000000000000047, gen_random_uuid(), 'sunqiang', '孙强', '$2b$12$T06KtP5UZLuKbgEccyCBa.9bW9nIysTPn0WyX5Bc/B3cxwLvxW62W', decode('5430364B745035555A4C754B6267456363794342612E', 'hex'), 'sunqiang@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 4000000000000000005, now(), null),
(4000000000000000048, gen_random_uuid(), 'zhoumin', '周敏', '$2b$12$PUJ3wLeG0VSqQoKdvu/NKuYcnyF4AgfZDES2UoktE3uAdTeergGB.', decode('50554A33774C654730565371516F4B6476752F4E4B75', 'hex'), 'zhoumin@example.com', 1, false, true, false, null, 'Asia/Shanghai', null, now(), null, now(), 2048601264366944256, now(), null);

insert into sys_user_role (id, user_id, role_id)
values
(2048601269739847680, 2048601269672738816, 2048601269345583104),
(2049946493732913152, 2049946297615646720, 2048601269345583104),
(4000000000000000051, 4000000000000000041, 4000000000000000011),
(4000000000000000052, 4000000000000000042, 2048601269345583104),
(4000000000000000053, 4000000000000000043, 4000000000000000012),
(4000000000000000054, 4000000000000000044, 2048601269345583104),
(4000000000000000055, 4000000000000000045, 2048601269345583104),
(4000000000000000056, 4000000000000000046, 4000000000000000011),
(4000000000000000057, 4000000000000000047, 2048601269345583104),
(4000000000000000058, 4000000000000000048, 4000000000000000013);

insert into sys_data_scope (id, name, status, created_time, updated_time)
values
(2048601269806956544, '本部门数据权限', 1, now(), null),
(2048601269869871104, '部门及以下数据权限', 1, now(), null),
(2048601269869871105, '仅本人数据权限', 1, now(), null),
(2048601269869871106, '全模型本部门数据权限', 1, now(), null),
(2048601269869871107, '排除超级管理员数据权限', 1, now(), null);

insert into sys_data_rule (id, name, model, "column", operator, expression, "value", created_time, updated_time)
values
(2048601269932785664, '部门 ID 等于当前用户部门', '__ALL__', '__dept_id__', 0, 0, '${dept_id}', now(), null),
(2048601269999894528, '部门编码等于 HQ', 'Dept', 'code', 1, 0, 'HQ', now(), null),
(2048601269999894529, '父部门 ID 等于总部部门 ID', 'Dept', 'parent_id', 0, 0, '2048601264366944256', now(), null),
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

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2049629108253622330, '查询', 'QuerySysUser', null, 1, null, 2, 'sys:user:list', 1, 0, '', null, 2049629108245233672, '2026-08-26 00:00:00', null),
(2049629108253622331, '查询', 'QuerySysConfig', null, 11, null, 2, 'sys:config:list', 1, 0, '', null, 2049629108245233667, '2026-08-26 00:00:00', null),
(2049629108253622332, '查询', 'QuerySysDataRule', null, 6, null, 2, 'data:rule:list', 1, 0, '', null, 2049629108249427969, '2026-08-26 00:00:00', null),
(2049629108253622333, '查询', 'QuerySysMenu', null, 4, null, 2, 'sys:menu:list', 1, 0, '', null, 2049629108245233680, '2026-08-26 00:00:00', null),
(2049629108253622334, '查询', 'QueryLoginLog', null, 2, null, 2, 'log:login:list', 1, 0, '', null, 2049629108249427984, '2026-08-26 00:00:00', null),
(2049629108253622335, '查询', 'QueryOperaLog', null, 3, null, 2, 'log:opera:list', 1, 0, '', null, 2049629108249427987, '2026-08-26 00:00:00', null),
(2049629108253622336, '查询', 'QuerySysRole', null, 4, null, 2, 'sys:role:list', 1, 0, '', null, 2049629108245233674, '2026-08-30 00:00:00', null),
(2049629108253622337, '查询', 'QuerySysDept', null, 2, null, 2, 'sys:dept:list', 1, 0, '', null, 2049629108245233668, '2026-08-30 00:00:00', null),
(2049629108253622338, '查询', 'QuerySysDataScope', null, 5, null, 2, 'data:scope:list', 1, 0, '', null, 2049629108249427969, '2026-08-30 00:00:00', null);
