delete from task_scheduler where task = 'notice.sync_inbox';

delete from sys_menu where name in ('AddNotice', 'EditNotice', 'DeleteNotice', 'ExportNotice');

delete from sys_menu where name = 'PluginNotice';

drop table if exists sys_notice;
