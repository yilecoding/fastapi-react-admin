DELETE FROM task_scheduler where task = 'notification.deliver_pending';

DELETE FROM sys_role_menu where menu_id in (2240000000000000001, 2240000000000000002, 2240000000000000003, 2240000000000000004, 2240000000000000005, 2240000000000000006, 2240000000000000007);

DELETE FROM sys_menu where name = 'ResendNotifyDelivery';

DELETE FROM sys_menu where name = 'QueryNotifyDelivery';

DELETE FROM sys_menu where name = 'EditNotifyPolicy';

DELETE FROM sys_menu where name = 'QueryNotifyPolicy';

DELETE FROM sys_menu where name = 'NotifyDelivery';

DELETE FROM sys_menu where name = 'NotifyPolicy';

DELETE FROM sys_menu where name = 'NotifyCenter';

DROP TABLE IF EXISTS sys_notification_delivery;

DROP TABLE IF EXISTS sys_notification_pref;

DROP TABLE IF EXISTS sys_notification_policy;

DELETE FROM sys_role_menu WHERE menu_id IN (2049629108262010880, 2049629108262010881);

DELETE FROM sys_menu WHERE name = 'SendNotification';

DELETE FROM sys_menu WHERE name = 'Notification';

DROP TABLE IF EXISTS sys_notification_read;

DROP TABLE IF EXISTS sys_notification;
