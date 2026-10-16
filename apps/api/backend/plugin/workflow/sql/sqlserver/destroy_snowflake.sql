DELETE FROM sys_role_menu WHERE menu_id IN (2049629108266205200, 2049629108266205201, 2049629108266205202, 2049629108266205203, 2049629108266205204, 2049629108266205205, 2049629108266205206, 2049629108266205207, 2049629108266205208, 2049629108266205209, 2049629108266205210);

DELETE FROM sys_menu WHERE name = 'TerminateWorkflowInstance';

DELETE FROM sys_menu WHERE name = 'QueryWorkflowInstance';

DELETE FROM sys_menu WHERE name = 'WorkflowMonitor';

DELETE FROM sys_menu WHERE name = 'PublishWorkflowDefinition';

DELETE FROM sys_menu WHERE name = 'DeleteWorkflowDefinition';

DELETE FROM sys_menu WHERE name = 'EditWorkflowDefinition';

DELETE FROM sys_menu WHERE name = 'AddWorkflowDefinition';

DELETE FROM sys_menu WHERE name = 'QueryWorkflowDefinition';

DELETE FROM sys_menu WHERE name = 'WorkflowDefinition';

DELETE FROM sys_menu WHERE name = 'WorkflowInbox';

DELETE FROM sys_menu WHERE name = 'Workflow';

DROP TABLE IF EXISTS wf_cc;

DROP TABLE IF EXISTS wf_action_record;

DROP TABLE IF EXISTS wf_task;

DROP TABLE IF EXISTS wf_instance;

DROP TABLE IF EXISTS wf_definition_version;

DROP TABLE IF EXISTS wf_definition;
