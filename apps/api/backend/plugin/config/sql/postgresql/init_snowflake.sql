insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108253622283, '参数配置', 'PluginConfig', '/plugins/config', 7, 'codicon:symbol-parameter', 1, null, 1, 1, '', null, 2049629108245233667, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2049629108253622284, '新增', 'AddConfig', null, 0, null, 2, 'sys:config:add', 1, 0, '', null, 2049629108253622283, now(), null),
(2049629108253622285, '修改', 'EditConfig', null, 0, null, 2, 'sys:config:edit', 1, 0, '', null, 2049629108253622283, now(), null),
(2049629108253622286, '删除', 'DeleteConfig', null, 0, null, 2, 'sys:config:del', 1, 0, '', null, 2049629108253622283, now(), null);

insert into sys_config (id, name, type, "key", value, is_frontend, remark, created_time, updated_time)
values
(2069061886627938304, '状态', 'EMAIL', 'EMAIL_CONFIG_STATUS', '1', false, null, now(), null),
(2069061886627938305, '服务器地址', 'EMAIL', 'EMAIL_HOST', 'smtp.qq.com', false, null, now(), null),
(2069061886627938306, '服务器端口', 'EMAIL', 'EMAIL_PORT', '465', false, null, now(), null),
(2069061886627938307, '邮箱账号', 'EMAIL', 'EMAIL_USERNAME', 'fba@qq.com', false, null, now(), null),
(2069061886627938308, '邮箱密码', 'EMAIL', 'EMAIL_PASSWORD', '', false, null, now(), null),
(2069061886627938309, 'SSL 加密', 'EMAIL', 'EMAIL_SSL', 'true', false, null, now(), null),
(2069061886627938310, '状态', 'USER_SECURITY', 'USER_SECURITY_CONFIG_STATUS', '1', false, null, now(), null),
(2069061886627938311, '密码错误锁定阈值', 'USER_SECURITY', 'USER_LOCK_THRESHOLD', '5', false, '0 表示禁用锁定', now(), null),
(2069061886627938312, '密码错误锁定时长（秒）', 'USER_SECURITY', 'USER_LOCK_SECONDS', '300', false, null, now(), null),
(2069061886627938313, '密码有效期（天）', 'USER_SECURITY', 'USER_PASSWORD_EXPIRY_DAYS', '365', false, '0 表示永不过期', now(), null),
(2069061886627938314, '密码到期提醒（天）', 'USER_SECURITY', 'USER_PASSWORD_REMINDER_DAYS', '7', false, '0 表示不提醒', now(), null),
(2069061886627938315, '密码历史检查次数', 'USER_SECURITY', 'USER_PASSWORD_HISTORY_CHECK_COUNT', '3', false, null, now(), null),
(2069061886627938316, '密码最小长度', 'USER_SECURITY', 'USER_PASSWORD_MIN_LENGTH', '6', false, null, now(), null),
(2069061886627938317, '密码最大长度', 'USER_SECURITY', 'USER_PASSWORD_MAX_LENGTH', '32', false, null, now(), null),
(2069061886627938318, '密码必须包含特殊字符', 'USER_SECURITY', 'USER_PASSWORD_REQUIRE_SPECIAL_CHAR', 'false', false, null, now(), null),
(2069061886627938319, '状态', 'LOGIN', 'LOGIN_CONFIG_STATUS', '1', false, null, now(), null),
(2069061886627938320, '验证码开关', 'LOGIN', 'LOGIN_CAPTCHA_ENABLED', 'true', false, null, now(), null),
(2202113487143047168, '开发配置总开关', 'DEV', 'DEV_CONFIG_STATUS', '1', true, null, now(), null),
(2202113487403094016, '组件沙箱', 'DEV', 'DEV_SANDBOX_ENABLED', 'true', true, null, now(), null),
(2224875016875409408, '状态', 'FILE', 'FILE_CONFIG_STATUS', '1', false, null, now(), null),
(2224875016875409409, '分片阈值（MiB）', 'FILE', 'FILE_CHUNK_THRESHOLD', '16', false, '不小于这个大小的文件分片上传；须小于反代的 client_max_body_size', now(), null),
(2224875016875409410, '分片大小（MiB）', 'FILE', 'FILE_CHUNK_SIZE', '8', false, '只影响新开始的上传；.env 同名项的单位是字节', now(), null),
(2224875016875409411, '状态', 'SESSION', 'SESSION_CONFIG_STATUS', '1', false, null, now(), null),
(2224875016875409412, '网页端空闲超时（分钟）', 'SESSION', 'SESSION_WEB_IDLE_MINUTES', '120', false, '这么久没有操作就自动退出；只影响之后的登录', now(), null),
(2224875016875409413, '网页端最长登录（天）', 'SESSION', 'SESSION_WEB_ABSOLUTE_DAYS', '7', false, '从登录那一刻起算，刷新不延长', now(), null),
(2224875016875409414, '网页端会话上限', 'SESSION', 'SESSION_WEB_MAX', '0', false, '同一账号在这一端最多几个会话，0 表示不限', now(), null),
(2224875016875409415, '网页端超限策略', 'SESSION', 'SESSION_WEB_OVERFLOW', 'evict_idle', false, 'evict_idle 挤掉最久没活跃的；deny 拒绝新登录', now(), null),
(2224875016875409416, '桌面端空闲超时（分钟）', 'SESSION', 'SESSION_DESKTOP_IDLE_MINUTES', '120', false, '这么久没有操作就自动退出；只影响之后的登录', now(), null),
(2224875016875409417, '桌面端最长登录（天）', 'SESSION', 'SESSION_DESKTOP_ABSOLUTE_DAYS', '7', false, '从登录那一刻起算，刷新不延长', now(), null),
(2224875016875409418, '桌面端会话上限', 'SESSION', 'SESSION_DESKTOP_MAX', '0', false, '同一账号在这一端最多几个会话，0 表示不限', now(), null),
(2224875016875409419, '桌面端超限策略', 'SESSION', 'SESSION_DESKTOP_OVERFLOW', 'evict_idle', false, 'evict_idle 挤掉最久没活跃的；deny 拒绝新登录', now(), null),
(2224875016875409420, '移动端空闲超时（分钟）', 'SESSION', 'SESSION_MOBILE_IDLE_MINUTES', '43200', false, '这么久没有操作就自动退出；只影响之后的登录', now(), null),
(2224875016875409421, '移动端最长登录（天）', 'SESSION', 'SESSION_MOBILE_ABSOLUTE_DAYS', '90', false, '从登录那一刻起算，刷新不延长', now(), null),
(2224875016875409422, '移动端会话上限', 'SESSION', 'SESSION_MOBILE_MAX', '1', false, '同一账号在这一端最多几个会话，0 表示不限', now(), null),
(2224875016875409423, '移动端超限策略', 'SESSION', 'SESSION_MOBILE_OVERFLOW', 'evict_idle', false, 'evict_idle 挤掉最久没活跃的；deny 拒绝新登录', now(), null),
(2224875016875409424, '状态', 'NOTIFICATION', 'NOTIFICATION_CONFIG_STATUS', '1', false, null, now(), null),
(2224875016875409425, '外部渠道总开关', 'NOTIFICATION', 'NOTIFICATION_EXTERNAL_ENABLED', 'true', false, '关掉后只写站内通知，邮件 / 短信一条都不发（已经在排队的照常发完）', now(), null),
(2224875016875409426, '失败重试次数', 'NOTIFICATION', 'NOTIFICATION_RETRY_MAX', '4', false, '不含第一次；结果未知的不重试', now(), null),
(2224875016875409427, '投递记录保留（天）', 'NOTIFICATION', 'NOTIFICATION_DELIVERY_RETENTION_DAYS', '30', false, '每天凌晨的日志清理一起删', now(), null);
