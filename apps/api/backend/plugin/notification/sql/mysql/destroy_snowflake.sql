delete from sys_role_menu where menu_id in (2049629108262010880, 2049629108262010881);

delete from sys_menu where name = 'SendNotification';

delete from sys_menu where name = 'Notification';

drop table if exists sys_notification_read;

drop table if exists sys_notification;
