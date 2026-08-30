DELETE FROM sys_role_menu WHERE menu_id IN (2049629108262010880, 2049629108262010881);

DELETE FROM sys_menu WHERE name = 'SendNotification';

DELETE FROM sys_menu WHERE name = 'Notification';

DROP TABLE IF EXISTS sys_notification_read;

DROP TABLE IF EXISTS sys_notification;
