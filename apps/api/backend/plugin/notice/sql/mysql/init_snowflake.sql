insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108257816576, '通知公告', 'PluginNotice', '/plugins/notice', 9, 'fe:notice-push', 1, null, 1, 1, '', null, 2049629108245233667, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2049629108257816577, '新增', 'AddNotice', null, 0, null, 2, 'sys:notice:add', 1, 0, '', null, 2049629108257816576, now(), null),
(2049629108257816578, '修改', 'EditNotice', null, 0, null, 2, 'sys:notice:edit', 1, 0, '', null, 2049629108257816576, now(), null),
(2049629108257816579, '删除', 'DeleteNotice', null, 0, null, 2, 'sys:notice:del', 1, 0, '', null, 2049629108257816576, now(), null),
(2049629108253622357, '导出', 'ExportNotice', null, 0, null, 2, 'sys:notice:export', 1, 0, '', null, 2049629108257816576, now(), null);

insert into sys_notice (id, title, type, status, content, created_time, updated_time, pinned, level, popup, require_ack, public)
values
(2112248797756129280, '系统升级公告：新增定时任务与数据权限模块', 1, 1, '各位同事：

系统本次升级新增了以下功能：

* **定时任务调度**：支持在「系统管理 - 定时任务」里配置周期任务，查看每次执行的详细记录
* **数据权限矩阵**：可以按部门/角色精细控制不同用户能看到哪些数据，详见「系统管理 - 数据权限」

升级期间历史数据不受影响，如有问题请联系系统管理员。', '2025-12-15 15:33:16', null, true, 1, false, false, false),
(3000000000000000061, '新功能上线：多页签与文件预览', 0, 1, '后台管理界面新增了多页签导航，切换菜单不会丢失已填写的表单内容；同时文件管理模块支持在线预览常见文档和图片格式，欢迎试用并反馈体验。', now(), null, false, 0, false, false, false),
(3000000000000000062, '关于近期系统维护窗口的通知', 1, 1, '为保障系统稳定运行，运维团队将在每周日凌晨 2:00-4:00 进行例行维护，期间系统可能出现短暂波动，敬请知悉。如有紧急业务需求，请提前与系统管理员沟通。', now(), null, false, 0, false, false, false);

insert into task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
values (2250000000000000101, '公告收件箱对时', 'notice.sync_inbox', null, null, null, null, null, null, null, 60, 0, 60, 'seconds', '* * * * *', 0, 1, 0, null, '每 60 秒对一次公告的收件箱：定时发布到点的发出去、过期的撤回。停用后定时发布的公告到点也不会出现，过期公告的消息会一直挂在铃铛里', now(), null, 0, null);
