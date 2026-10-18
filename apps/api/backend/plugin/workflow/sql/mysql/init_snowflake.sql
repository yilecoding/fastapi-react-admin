insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205200, '审批', 'Workflow', '/workflow', 2, 'mdi:file-sign', 0, null, 1, 1, '', null, null, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205201, '审批中心', 'WorkflowInbox', '/workflow/inbox', 1, 'mdi:inbox-outline', 1, null, 1, 1, '', null, 2049629108266205200, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205202, '流程定义', 'WorkflowDefinition', '/workflow/definition', 2, 'mdi:sitemap-outline', 1, null, 1, 1, '', null, 2049629108266205200, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205203, '查询', 'QueryWorkflowDefinition', null, 0, null, 2, 'workflow:definition:list', 1, 0, '', null, 2049629108266205202, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205204, '新增', 'AddWorkflowDefinition', null, 1, null, 2, 'workflow:definition:add', 1, 0, '', null, 2049629108266205202, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205205, '修改', 'EditWorkflowDefinition', null, 2, null, 2, 'workflow:definition:edit', 1, 0, '', null, 2049629108266205202, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205206, '删除', 'DeleteWorkflowDefinition', null, 3, null, 2, 'workflow:definition:del', 1, 0, '', null, 2049629108266205202, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205207, '发布', 'PublishWorkflowDefinition', null, 4, null, 2, 'workflow:definition:publish', 1, 0, '', null, 2049629108266205202, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205208, '实例监控', 'WorkflowMonitor', '/workflow/monitor', 3, 'mdi:monitor-eye', 1, null, 1, 1, '', null, 2049629108266205200, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205209, '查询', 'QueryWorkflowInstance', null, 0, null, 2, 'workflow:instance:list', 1, 0, '', null, 2049629108266205208, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205210, '终止', 'TerminateWorkflowInstance', null, 1, null, 2, 'workflow:instance:terminate', 1, 0, '', null, 2049629108266205208, now(), null);

insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values (2049629108266205211, '改办理人', 'ReassignWorkflowInstance', null, 2, null, 2, 'workflow:instance:reassign', 1, 0, '', null, 2049629108266205208, now(), null);

insert into sys_role_menu (id, role_id, menu_id)
values
(3000000000000000091, 2048601263515500544, 2049629108266205200),
(3000000000000000092, 2048601263515500544, 2049629108266205201),
(3000000000000000093, 3000000000000000011, 2049629108266205200),
(3000000000000000094, 3000000000000000011, 2049629108266205201),
(3000000000000000095, 3000000000000000012, 2049629108266205200),
(3000000000000000096, 3000000000000000012, 2049629108266205201),
(3000000000000000097, 3000000000000000013, 2049629108266205200),
(3000000000000000098, 3000000000000000013, 2049629108266205201);

insert into wf_definition (id, code, name, biz_type, category, icon, description, status, draft_form_json, draft_model_json, current_version_id, sort, created_time, updated_time, deleted, deleted_time)
values (3000000000000000101, 'LEAVE', '请假', 'form', '人事', 'mdi:beach', '示例：直属主管 → 超过 3 天加上级主管 → 人事备案 → 抄送交接人', 'published', '{"schemaVersion":1,"fields":[{"id":"f_type","type":"select","label":"请假类型","required":true,"options":[{"label":"年假","value":"annual"},{"label":"事假","value":"personal"},{"label":"病假","value":"sick"}]},{"id":"f_range","type":"daterange","label":"请假时间","required":true},{"id":"f_days","type":"number","label":"请假天数","calc":{"kind":"days","field":"f_range"}},{"id":"f_reason","type":"textarea","label":"请假事由","required":true},{"id":"f_proof","type":"attachment","label":"病假证明","required":true,"visibleWhen":{"all":[{"var":"f_type","op":"in","value":["sick"]}]}},{"id":"f_handover","type":"user","label":"工作交接人"},{"id":"f_hr_note","type":"textarea","label":"人事备注","placeholder":"人事审批时填写"}]}', '{"schemaVersion":1,"root":{"type":"start","id":"start","fieldPerms":{"f_hr_note":"hidden"},"next":{"type":"approval","id":"n_leader","name":"直属主管","mode":"any","assignee":{"kind":"dept_leader","level":1},"onEmpty":"admin","actions":null,"fieldPerms":{"f_hr_note":"hidden"},"next":{"type":"condition","id":"c_days","name":"按天数分支","branches":[{"id":"b_long","name":"超过 3 天","when":{"all":[{"var":"f_days","op":"gt","value":3}]},"child":{"type":"approval","id":"n_upper","name":"上级主管","mode":"any","assignee":{"kind":"dept_leader","level":2},"onEmpty":"skip","actions":null,"fieldPerms":{"f_hr_note":"hidden"},"next":null}},{"id":"b_default","name":"其他","default":true,"child":null}],"next":{"type":"approval","id":"n_hr","name":"人事备案","mode":"any","assignee":{"kind":"role","role_ids":["3000000000000000012"],"scope":"none"},"onEmpty":"skip","actions":[],"fieldPerms":{"f_hr_note":"editable"},"next":{"type":"cc","id":"cc_handover","name":"抄送交接人","targets":[{"kind":"var_user","field":"f_handover"}],"next":null}}}}}}', 3000000000000000102, 0, now(), null, 0, null);

insert into wf_definition_version (id, definition_id, version_no, form_json, model_json, published_by, created_time, updated_time)
values (3000000000000000102, 3000000000000000101, 1, '{"schemaVersion":1,"fields":[{"id":"f_type","type":"select","label":"请假类型","required":true,"options":[{"label":"年假","value":"annual"},{"label":"事假","value":"personal"},{"label":"病假","value":"sick"}]},{"id":"f_range","type":"daterange","label":"请假时间","required":true},{"id":"f_days","type":"number","label":"请假天数","calc":{"kind":"days","field":"f_range"}},{"id":"f_reason","type":"textarea","label":"请假事由","required":true},{"id":"f_proof","type":"attachment","label":"病假证明","required":true,"visibleWhen":{"all":[{"var":"f_type","op":"in","value":["sick"]}]}},{"id":"f_handover","type":"user","label":"工作交接人"},{"id":"f_hr_note","type":"textarea","label":"人事备注","placeholder":"人事审批时填写"}]}', '{"schemaVersion":1,"root":{"type":"start","id":"start","fieldPerms":{"f_hr_note":"hidden"},"next":{"type":"approval","id":"n_leader","name":"直属主管","mode":"any","assignee":{"kind":"dept_leader","level":1},"onEmpty":"admin","actions":null,"fieldPerms":{"f_hr_note":"hidden"},"next":{"type":"condition","id":"c_days","name":"按天数分支","branches":[{"id":"b_long","name":"超过 3 天","when":{"all":[{"var":"f_days","op":"gt","value":3}]},"child":{"type":"approval","id":"n_upper","name":"上级主管","mode":"any","assignee":{"kind":"dept_leader","level":2},"onEmpty":"skip","actions":null,"fieldPerms":{"f_hr_note":"hidden"},"next":null}},{"id":"b_default","name":"其他","default":true,"child":null}],"next":{"type":"approval","id":"n_hr","name":"人事备案","mode":"any","assignee":{"kind":"role","role_ids":["3000000000000000012"],"scope":"none"},"onEmpty":"skip","actions":[],"fieldPerms":{"f_hr_note":"editable"},"next":{"type":"cc","id":"cc_handover","name":"抄送交接人","targets":[{"kind":"var_user","field":"f_handover"}],"next":null}}}}}}', 2048601263834267648, now(), null);

insert into task_scheduler (id, name, task, args, kwargs, queue, exchange, routing_key, start_time, expire_time, expire_seconds, type, interval_every, interval_period, crontab, one_off, enabled, total_run_count, last_run_time, remark, created_time, updated_time, deleted, deleted_time)
values (2049629108266205230, '审批超时处理', 'workflow.handle_timeouts', null, null, null, null, null, null, null, null, 1, null, null, '*/5 * * * *', 0, 1, 0, null, '每 5 分钟扫一遍审批待办：节点配了超时的，按配置提醒 / 自动同意 / 自动驳回', now(), null, 0, null);
