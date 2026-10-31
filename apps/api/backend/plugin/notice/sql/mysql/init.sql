set @system_menu_id = (select id from sys_menu where name = 'System');

insert into sys_menu (title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values ('通知公告', 'PluginNotice', '/plugins/notice', 9, 'fe:notice-push', 1, null, 1, 1, '', null, @system_menu_id, now(), null);

set @notice_menu_id = LAST_INSERT_ID();

insert into sys_menu (title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
('新增', 'AddNotice', null, 0, null, 2, 'sys:notice:add', 1, 0, '', null, @notice_menu_id, now(), null),
('修改', 'EditNotice', null, 0, null, 2, 'sys:notice:edit', 1, 0, '', null, @notice_menu_id, now(), null),
('删除', 'DeleteNotice', null, 0, null, 2, 'sys:notice:del', 1, 0, '', null, @notice_menu_id, now(), null),
('导出', 'ExportNotice', null, 0, null, 2, 'sys:notice:export', 1, 0, '', null, @notice_menu_id, now(), null);

insert into sys_notice (id, title, type, status, content, created_time, updated_time, pinned, level, popup, require_ack, public)
values (1, 'hahahahahaahahaha', 0, 1, '你好😄

```
print(''fba yyds'')
```

⚡⚡⚡

| col1 | col2 | col3 |
| ---- | ---- | ---- |
|      |      |      |
|      |      |      |

* 1
* 2
* 3
', '2025-12-15 15:33:16', null, false, 0, false, false, false);

insert into task_scheduler (name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
values ('公告收件箱对时', 'notice.sync_inbox', null, null, null, null, null, null, null, 60, 0, 60, 'seconds', '* * * * *', 0, 1, 0, null, '每 60 秒对一次公告的收件箱：定时发布到点的发出去、过期的撤回。停用后定时发布的公告到点也不会出现，过期公告的消息会一直挂在铃铛里', now(), null, 0, null);
