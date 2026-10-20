INSERT INTO sys_menu (id, title, name, path, sort, icon, type, perms, status, display, link, remark, parent_id, created_time, updated_time)
VALUES
(2210000000000000001, N'AI 助手', 'AiAssistant', '/ai', 8, 'mdi:robot-outline', 0, NULL, 1, 1, '', NULL, NULL, GETDATE(), NULL),
(2210000000000000002, N'对话助手', 'AiChat', '/ai/chat', 1, 'mdi:chat-processing-outline', 1, NULL, 1, 1, '', NULL, 2210000000000000001, GETDATE(), NULL),
(2210000000000000003, N'模型密钥管理', 'AiProvider', '/ai/provider', 2, 'mdi:key-variant', 1, NULL, 1, 1, '', NULL, 2210000000000000001, GETDATE(), NULL),
(2210000000000000004, N'调用日志', 'AiToolLog', '/ai/tool-log', 3, 'mdi:history', 1, NULL, 1, 1, '', NULL, 2210000000000000001, GETDATE(), NULL),
(2210000000000000005, N'发起对话', 'UseAiChat', NULL, 0, NULL, 2, 'ai:chat:use', 1, 0, '', NULL, 2210000000000000002, GETDATE(), NULL),
(2210000000000000006, N'查询', 'QueryAiProvider', NULL, 0, NULL, 2, 'ai:provider:list', 1, 0, '', NULL, 2210000000000000003, GETDATE(), NULL),
(2210000000000000007, N'新增', 'AddAiProvider', NULL, 1, NULL, 2, 'ai:provider:add', 1, 0, '', NULL, 2210000000000000003, GETDATE(), NULL),
(2210000000000000008, N'修改', 'EditAiProvider', NULL, 2, NULL, 2, 'ai:provider:edit', 1, 0, '', NULL, 2210000000000000003, GETDATE(), NULL),
(2210000000000000009, N'删除', 'DeleteAiProvider', NULL, 3, NULL, 2, 'ai:provider:del', 1, 0, '', NULL, 2210000000000000003, GETDATE(), NULL),
(2210000000000000010, N'查询', 'QueryAiToolLog', NULL, 0, NULL, 2, 'ai:log:list', 1, 0, '', NULL, 2210000000000000004, GETDATE(), NULL),
(2210000000000000011, N'MCP 凭据', 'AiMcpClient', '/ai/mcp-client', 4, 'mdi:api', 1, NULL, 1, 1, '', NULL, 2210000000000000001, GETDATE(), NULL),
(2210000000000000012, N'查询', 'QueryAiMcpClient', NULL, 0, NULL, 2, 'ai:mcp:list', 1, 0, '', NULL, 2210000000000000011, GETDATE(), NULL),
(2210000000000000013, N'新增', 'AddAiMcpClient', NULL, 1, NULL, 2, 'ai:mcp:add', 1, 0, '', NULL, 2210000000000000011, GETDATE(), NULL),
(2210000000000000014, N'修改', 'EditAiMcpClient', NULL, 2, NULL, 2, 'ai:mcp:edit', 1, 0, '', NULL, 2210000000000000011, GETDATE(), NULL),
(2210000000000000015, N'删除', 'DeleteAiMcpClient', NULL, 3, NULL, 2, 'ai:mcp:del', 1, 0, '', NULL, 2210000000000000011, GETDATE(), NULL);
