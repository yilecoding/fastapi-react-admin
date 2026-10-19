insert into sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
values
(2210000000000000001, 'AI 助手', 'AiAssistant', '/ai', 8, 'mdi:robot-outline', 0, null, 1, 1, '', null, null, now(), null),
(2210000000000000002, '对话助手', 'AiChat', '/ai/chat', 1, 'mdi:chat-processing-outline', 1, null, 1, 1, '', null, 2210000000000000001, now(), null),
(2210000000000000003, '模型密钥管理', 'AiProvider', '/ai/provider', 2, 'mdi:key-variant', 1, null, 1, 1, '', null, 2210000000000000001, now(), null),
(2210000000000000004, '调用日志', 'AiToolLog', '/ai/tool-log', 3, 'mdi:history', 1, null, 1, 1, '', null, 2210000000000000001, now(), null),
(2210000000000000005, '发起对话', 'UseAiChat', null, 0, null, 2, 'ai:chat:use', 1, 0, '', null, 2210000000000000002, now(), null),
(2210000000000000006, '查询', 'QueryAiProvider', null, 0, null, 2, 'ai:provider:list', 1, 0, '', null, 2210000000000000003, now(), null),
(2210000000000000007, '新增', 'AddAiProvider', null, 1, null, 2, 'ai:provider:add', 1, 0, '', null, 2210000000000000003, now(), null),
(2210000000000000008, '修改', 'EditAiProvider', null, 2, null, 2, 'ai:provider:edit', 1, 0, '', null, 2210000000000000003, now(), null),
(2210000000000000009, '删除', 'DeleteAiProvider', null, 3, null, 2, 'ai:provider:del', 1, 0, '', null, 2210000000000000003, now(), null),
(2210000000000000010, '查询', 'QueryAiToolLog', null, 0, null, 2, 'ai:log:list', 1, 0, '', null, 2210000000000000004, now(), null);
