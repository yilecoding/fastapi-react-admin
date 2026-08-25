INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES (2049629108257816576, N'通知公告', 'PluginNotice', '/plugins/notice', 9, 'fe:notice-push', 1, NULL, 1, 1, '', NULL, 2049629108245233667, GETDATE(), NULL);

INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2049629108257816577, N'新增', 'AddNotice', NULL, 0, NULL, 2, 'sys:notice:add', 1, 0, '', NULL, 2049629108257816576, GETDATE(), NULL),
(2049629108257816578, N'修改', 'EditNotice', NULL, 0, NULL, 2, 'sys:notice:edit', 1, 0, '', NULL, 2049629108257816576, GETDATE(), NULL),
(2049629108257816579, N'删除', 'DeleteNotice', NULL, 0, NULL, 2, 'sys:notice:del', 1, 0, '', NULL, 2049629108257816576, GETDATE(), NULL);

INSERT INTO sys_notice (id, title, type, status, content, created_time, updated_time)
VALUES
(2112248797756129280, N'系统升级公告：新增定时任务与数据权限模块', 1, 1, N'各位同事：

系统本次升级新增了以下功能：

* **定时任务调度**：支持在「系统管理 - 定时任务」里配置周期任务，查看每次执行的详细记录
* **数据权限矩阵**：可以按部门/角色精细控制不同用户能看到哪些数据，详见「系统管理 - 数据权限」

升级期间历史数据不受影响，如有问题请联系系统管理员。', '2025-12-15 15:33:16', NULL),
(3000000000000000061, N'新功能上线：多页签与文件预览', 0, 1, N'后台管理界面新增了多页签导航，切换菜单不会丢失已填写的表单内容；同时文件管理模块支持在线预览常见文档和图片格式，欢迎试用并反馈体验。', GETDATE(), NULL),
(3000000000000000062, N'关于近期系统维护窗口的通知', 1, 1, N'为保障系统稳定运行，运维团队将在每周日凌晨 2:00-4:00 进行例行维护，期间系统可能出现短暂波动，敬请知悉。如有紧急业务需求，请提前与系统管理员沟通。', GETDATE(), NULL);
