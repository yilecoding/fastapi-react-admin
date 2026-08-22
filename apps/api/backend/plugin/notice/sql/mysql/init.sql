set @system_menu_id = (select id from sys_menu where name = 'System');

insert into sys_menu (title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values ('通知公告', 'PluginNotice', '/plugins/notice', 9, 'fe:notice-push', 1, null, 1, 1, '', null, @system_menu_id, now(), null);

set @notice_menu_id = LAST_INSERT_ID();

insert into sys_menu (title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
('新增', 'AddNotice', null, 0, null, 2, 'sys:notice:add', 1, 0, '', null, @notice_menu_id, now(), null),
('修改', 'EditNotice', null, 0, null, 2, 'sys:notice:edit', 1, 0, '', null, @notice_menu_id, now(), null),
('删除', 'DeleteNotice', null, 0, null, 2, 'sys:notice:del', 1, 0, '', null, @notice_menu_id, now(), null);

insert into sys_notice (id, title, type, status, content, created_time, updated_time)
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
', '2025-12-15 15:33:16', null);
