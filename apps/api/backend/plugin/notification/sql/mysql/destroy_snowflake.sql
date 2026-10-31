delete from task_scheduler where task = 'notification.deliver_pending';

delete from sys_role_menu where menu_id in (2240000000000000001, 2240000000000000002, 2240000000000000003, 2240000000000000004, 2240000000000000005, 2240000000000000006, 2240000000000000007, 2240000000000000008, 2240000000000000009, 2240000000000000010, 2240000000000000011, 2240000000000000012, 2240000000000000013);

delete from sys_menu where name = 'TestNotifyBot';

delete from sys_menu where name = 'DeleteNotifyBot';

delete from sys_menu where name = 'EditNotifyBot';

delete from sys_menu where name = 'AddNotifyBot';

delete from sys_menu where name = 'QueryNotifyBot';

delete from sys_menu where name = 'NotifyBot';

delete from sys_menu where name = 'ResendNotifyDelivery';

delete from sys_menu where name = 'QueryNotifyDelivery';

delete from sys_menu where name = 'EditNotifyPolicy';

delete from sys_menu where name = 'QueryNotifyPolicy';

delete from sys_menu where name = 'NotifyDelivery';

delete from sys_menu where name = 'NotifyPolicy';

delete from sys_menu where name = 'NotifyCenter';

drop table if exists sys_notification_audience;

drop table if exists sys_notification_bot;

drop table if exists sys_notification_delivery;

drop table if exists sys_notification_pref;

drop table if exists sys_notification_policy;

delete from sys_role_menu where menu_id in (2049629108262010880, 2049629108262010881);

delete from sys_menu where name = 'SendNotification';

delete from sys_menu where name = 'Notification';

drop table if exists sys_notification_read;

drop table if exists sys_notification;
