-- AI 助手插件的种子菜单。
-- 🔴 权限码必须和三处保持一致：后端 RequestPermission、前端 <Can perm>、这里。
--    对账由 app/admin/tests/security/test_permission_codes.py 负责，任一方向漂移会红。
--
-- ⚠️ **刻意没有 sys_role_menu 授权行。** 两个理由：
--   1. 超管本来就拿得到全部菜单（`menu_service.get_sidebar` 对 is_superuser
--      走的是 `get_sidebar(db, None)`），不需要授权行
--   2. 哪些非超管角色该有 AI 入口是**每套部署自己的产品决定**。基础种子里的
--      STAFF 是「只看仪表盘和个人中心」的角色，给它一个能枚举系统数据的
--      对话入口不该是开箱默认值

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
(2210000000000000010, N'查询', 'QueryAiToolLog', NULL, 0, NULL, 2, 'ai:log:list', 1, 0, '', NULL, 2210000000000000004, GETDATE(), NULL);
