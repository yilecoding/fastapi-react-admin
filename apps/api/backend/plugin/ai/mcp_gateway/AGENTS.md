# plugin/ai/mcp_gateway —— 外部系统替人发起时的那道人工确认与身份边界

> 这份文件是 [AI 插件分册](../AGENTS.md) 的**子分册**（网关的装配、限流、凭据表在那一份的「MCP 网关」一节）。
> 跨模块纪律在根分册；新增结论写进离代码最近的分册。

## 🔴 `AI_CONFIRM_MUTATING_TOOLS = false` 只免得了「本人在场」时的确认（#314）

**症状**：关掉这个开关（本意是「我自己聊天时别老弹卡片」）的同时，开了 `allow_write` 的 MCP 凭据也不再只预演 ——
外部系统带 `X-Acting-User: 张三` 调 `dept_create` / `role_update_menus` / `wf_approve`，不经张三确认直接执行。
`server.py` 的注释写着「开了 allow_write 也只走到预演 + 确认令牌」，那句话只在开关为 true 时成立。
**根因**：`core/dispatcher.py` 只看开关，不看是谁在发话。
**修法**：`RunContext.user_present`（被代表的人此刻就在这个会话里亲手发话）。dispatcher 判
`(开关 or not ctx.user_present) and not pre_approved`；只有网页对话（`chat_service` 的 `/stream`）置 `True`，
MCP 显式置 `False`。🔴 **默认 `False`（fail-closed）**：以后加的入口忘了设，结果是照样要确认，而不是悄悄放开写操作。

## 🔴 发凭据的人自己要够格：`allow_superuser` / `act_as` 的 `*` / 点名的人 / 换令牌（#314）

**症状**：被授予 `ai:mcp:add` / `edit` 的非超管管理员能发一份 `allow_superuser=true` + `act_as=["*"]` 的凭据，
再带 `X-Acting-User: admin` 调网关 —— 以超管身份跑全部只读工具，不受他自己的数据范围限制。
**根因**：`service/mcp_client_service.py: _check` 只校验「用户名存在、工具存在」。
**修法**：`_check_grantable(act_as, allow_superuser, operator)`，非超管：`allow_superuser` 和 `*` 不能设；
点名的人必须在**操作者**的数据范围内（`scoped_to_user(operator)` 显式锚定）。三处都过这道闸：
- 新建、更新（按改完之后的值判 —— PUT 带回整份配置，超管发的凭据非超管连备注都改不了，改了就等于重新发一次）
- 🔴 **换令牌**（issue 里没写，修的时候发现的）：换令牌 = 拿到一把能代表 `act_as` 里那些人的明文令牌。
  不查的话，非超管给超管发的 `allow_superuser` 凭据点一下「重新生成」，就拿到了能代表 admin 的令牌
- 范围外的人和不存在的人**报同一句话**、而且这道闸在「用户名存在」之前跑：先查存在的话，
  「不存在」和「不在范围内」两句不同的报错就是一个按用户名探测范围外的人在不在的口子

**实测证据**（2026-11-16，PostgreSQL 私有测试库）：`tests/test_ai_mcp_trust.py` 8 条（会话回滚）+ `test_ai_mcp.py`
新增一条走真实 MCP HTTP（开关关掉后 MCP 调 `dept_create` 仍只发确认令牌、库里没有部门），AI 插件 165 条全过。
变异各打红：dispatcher 只看开关 → 2 条 · 新建不查 → 3 条 · 换令牌不查 → 1 条 · 范围查询改成 `bypass_data_scope` → 1 条 ·
先查存在再查范围 → 1 条（两句报错对不上）。⚠️ 两处变异没打红：`chat_service` 不置 `user_present=True`（测试直接造的
`RunContext`，没走 `/stream`，所以没守住「开关对网页对话仍然有效」的那条装配）；改范围外那句报错的措辞（两种情况走的是同一行，
改了一起变 —— 等价变异）。
