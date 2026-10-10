# plugin/ai —— AI 助手（可插拔 agent 引擎 + 受 RBAC 约束的系统操作工具）

> 应用级插件（`[app] router = ["v1"]`），接口在 `/api/v1/ai/*`。设计与选型见 issue #104。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 三层可插拔，一层焊死

| 层 | 接缝 | 换它要改什么 |
|---|---|---|
| **引擎**（谁驱动对话） | `core/ports.py: AgentRuntimePort` | 一个适配器文件 + `AI_AGENT_ENGINE` 一个值 |
| **入口**（用户从哪进来） | `core/events.py` 的事件协议 | 加一个入口，不动引擎和工具 |
| **工具集**（AI 能做什么） | `core/registry.py: @ai_tool` | 加一个文件，下游项目不改插件源码 |

🔴 **`core/dispatcher.py` 是唯一不可插拔的那层**：权限码过滤 / 数据范围继承 /
二次确认 / 审计落库全在这里。引擎（进程内循环、将来的 Node sidecar…）对系统来说
都是**不受信任的建议者**，它只能提议调用某个工具。

🔴 **「不受信任」是结构，不是约定：引擎手上没有可执行体。** 端口 `run(tools=...)`
收的是 `ToolSchema`（name / description / parameters / mutating，纯数据），
不是带 `handler` 的 `ToolSpec`。原来收的是后者，pydantic-ai spike 实测过那个洞：
适配器里写一句 `Tool(spec.handler)`，框架直接执行，权限 / 确认 / 审计全跳过，
**不报任何错**。守卫 `tests/test_ai_security.py::TestEnginesNeverHoldExecutables`
（端口类型 · schema 无可调用字段 · `engines/` 里不许出现 `.handler` / `.visible_tools` /
import `core.registry`），**做过变异检验**（三种绕过各打红一条）。
写新引擎时要执行工具，唯一的路是 `tool_dispatcher.dispatch(ToolCallRequest(...), ctx)`。

安全逻辑一旦下沉进引擎适配器，就会变成"每接一个引擎写一遍"——而那正是
[`common/security` 分册](../../common/security/AGENTS.md) 里反复出现的失败模式
（两套相似但独立的东西必然漂移），且漂移的表现是静默越权。

## 🔴 工具权限判定必须跟 `rbac_verify` 同步改

`core/permission.py` 是照着 `common/security/rbac.py: rbac_verify()` 的分支逐条写的
（前者返回布尔用于过滤清单，后者抛异常用于拦请求）。**改 `rbac_verify` 的判据时这里要跟着改**——
两边分叉的表现是：界面上点不到的按钮，换成"让 AI 帮我做"就能做。

其中 `user_can_mutate()` 那条**不是多余的**：`rbac_verify` 对非 GET 请求额外要求
`is_staff`，而工具调用不经过 HTTP 方法，够不着那道闸。守卫在
`tests/test_ai_security.py::test_mutating_requires_is_staff`，**做过变异检验**
（摘掉 `is_staff` 判断那条测试当场红）。

## 🔴 行级数据权限由 dispatcher 锚定，不靠「中间件反正会设」

`DataScopedCRUD._data_scope_condition()` 在 `_current_user` 为 `None` 时
**不加任何过滤**（= 看全部）。那是给 Celery / CLI / 启动期用的 fail-open，
对它们是对的——那些路径没有「谁在看」这个概念。

🔴 **但 `set_current_user()` 全仓只有 `middleware/jwt_auth_middleware.py` 调。**
今天只有网页 SSE 一个入口、走 JWT，所以没事；设计里「入口可插拔」那一层一旦落地
（API key / MCP / sidecar），新入口忘了设上下文就是**受限用户通过 AI 拿到全量数据**，
而接口返回 200、审计记「成功」、界面一切正常——没有任何现象。

所以 `dispatch()` 自己用 `scoped_to_user(ctx.user)`（`common/security/data_scope.py`）
把上下文建起来再执行 handler。它是工具执行的**唯一**通路，在这里锚定 =
以后加入口不用再想这件事。

守卫：`tests/test_ai_security.py::TestDispatcherAnchorsDataScope`，**做过变异检验**
（摘掉 `scoped_to_user` / 换成不还原的裸 `set_current_user`，各打红一条）。

⚠️ **这两条测试必须在干净的上下文里跑** —— 在已经设好上下文的情况下测，
测的是中间件而不是这道闸。

🔴 **而且「还原」那条的断言必须和 dispatch 在同一个协程里。** 第一版写的是
`asyncio.run(dispatch(...))` 然后在外面读 `_current_user`，那条测试**永远不会失败**：
`asyncio.run` 把协程放进一个新任务，任务拿的是上下文的**副本**，里面的 `set`
传不回调用方。是变异检验抓出来的——它当时是绿的，而且看起来完全合理。

## 🔴 数据范围：什么都不做才是对的，加一句 bypass 就漏

`jwt_auth_middleware` 已经把当前用户写进了 `data_scope` 的 ContextVar，所以工具走
service 层时**自动**继承调用者的可见范围。反过来说：谁在工具里图省事调一句
`bypass_data_scope()`，受限用户就会通过 AI 看到全量数据——而那个豁免的本意是给
"非展示的内部读"（登录查重、冲突检查）用的。

⚠️ **例外是部门**：`dept_service.get_tree` 的数据过滤是**显式入参**（`data_filter`），
不走 ContextVar。所以 `tools/dept_tools.py` 必须自己算一遍
`filter_data_permission_for_user(ctx.user, Dept)`——少了它，只该看见本部门的人
问"有哪些部门"会拿到整棵组织树。

## 🔴 SSE：三个会静默坏的地方

- **不能用注入进来的 `CurrentSession`。** FastAPI 的 yield 依赖在 `StreamingResponse`
  开始发送**之前**就被收尾了，拿它在生成器里用会在流到一半时撞 "session is closed"——
  而前几帧已经正常发出去了，表现成"AI 说到一半突然断"。`chat_service` 自己开会话，
  代价是它绕过了依赖注入，所以**必须**登记进 `backend/conftest.py` 的
  `_PATCHED_SESSION_MODULES`（不登记就是跑测试往开发库写对话记录）
- **帧结尾必须是两个换行**（`data: {...}\n\n`）。少一个浏览器一直等下一行，整条流卡住不出字
- **工具调用的分片要按 `index` 累积**（`llm/client.py: accumulate_tool_calls`）。
  OpenAI 把一次调用拆成多个 delta 发，`id` 只在第一片里、`arguments` 是**被切碎的字符串**。
  每片当成一次独立调用的话，表现是"模型调用了 20 次工具、每次参数都是残缺 JSON"，
  而错误会被当成"模型参数填错了"，永远查不到流式解析这一层。守卫：
  `tests/test_ai_security.py::TestStreamParsing`

## 🔴 内网网关的两条约束（来自 sop2ppt 的实测）

`llm/client.py` 里那两个参数不是可选项：

| 参数 | 不设的表现 |
|---|---|
| `verify=False`（供应商配置里的 `verify_ssl`） | 内网自签证书 Python 的 certifi 验不过，报 `SSLCertVerificationError`，**看起来像网关挂了** |
| `trust_env=False` | 企业代理到不了内网网关，请求被代理吞掉，表现是**超时**——而网关本身是好的 |

`base_url` **刻意不强制要求带 `/v1`**（不是所有网关都用这个版本段，硬卡会把合法配置拒掉）。
漏写的后果（404）由 `_explain_http_error` 在出错那一刻解释清楚。

## 🔴 布尔列不能用 `.is_(True)` —— SQL Server 上是非法语法

`crud_provider.clear_default()` 第一版写的是 `AiProvider.is_default.is_(True)`，
SQLAlchemy 把它编译成 `is_default IS 1`，**SQL Server 直接语法错**：
`Incorrect syntax near '1'` → 创建默认供应商的接口 500。
实测踩到（PostgreSQL 上不会报，所以本地默认库换成 PG 之后更难发现）。

用 `== True`（配 `# noqa: E712`）：它在 SQL Server 上渲染成 `= 1`、在 PG 上是 `= true`。

⚠️ 同一族里还有一个**更阴**的：`deleted.is_(False)` 在 SQL Server 上**不报错，
只是永远匹配不到**（`app/task/tests/test_scheduler.py` 记过）。
判据：**凡是拿布尔/整数列做条件，用 `==`，不要用 `.is_()`**；
`.is_()` 只留给真正的 `NULL` 判断。

## 密钥

- `AESCipher`（`utils/encrypt.py`）加密落库，密钥取 `AI_ENCRYPT_SECRET_KEY`
- 🔴 **没配密钥就拒绝保存，不静默存明文**——"存了但没加密"在界面上和"存了且加密了"
  完全一样，等发现时密钥已经在库里躺了很久
- 🔴 **响应 schema 里既没有明文也没有密文**，只有掩码。密文一旦出现在响应里，
  它就和明文一样值钱了（密文 + 一次代码泄露 = 明文）。守卫：`TestSecretsNeverLeak`
- 它在 `plugin.toml` 里的默认值是 `""`，真值放 `.env`（`.env` 优先级高于 plugin.toml）。
  这样**不会因为没配就启动不了**，而 fail-closed 的检查仍然在

## 种子菜单刻意没有 `sys_role_menu` 授权行

超管本来就拿得到全部菜单（`menu_service.get_sidebar` 对 `is_superuser` 走
`get_sidebar(db, None)`），不需要授权行；而哪些非超管角色该有 AI 入口是**每套部署
自己的产品决定**——基础种子里的 `STAFF` 是"只看仪表盘和个人中心"的角色，
给它一个能枚举系统数据的对话入口不该是开箱默认值。

⚠️ 第一版误把 `2048601269345583104` 当成超管角色授权了，那个 ID 其实是 **STAFF**。
改种子里的角色授权前，**先去 `backend/sql/*/init_snowflake_test_data.sql` 确认那个 ID 是谁**。

## 🔴 筛选参数要对齐三层，少一层都是「死控件」

审计列表的「调用时间」范围踩过一次，症状是**筛选条件完全不起作用**，而每一层看起来都对：
URL 变了、请求发出去了、接口返回 200、页面照常渲染——只是返回的始终是全量。

根因是三层里断了一层，而**每一处断法都不报错**：

| 断在哪 | 表现 |
|---|---|
| DAO 收了参数、接口没声明 | **FastAPI 静默丢弃**未声明的查询参数。这次就是它 |
| 接口声明了、没往 DAO 传 | 最阴的一种：签名对齐、类型检查过、OpenAPI 里也看得见那个参数 |
| DAO 声明了、没拼进 `kwargs` | SQL 里压根没有那个 WHERE |

守卫是 `tests/test_ai_security.py::TestLogFilterParams` 四条，**每条都做过变异检验**
（摘掉签名 / 删一处透传 / 让 `created_time__le` 不生效，各自打红对应的那一条）。
**新增筛选维度时不用改测试**——它是按签名求差集的，漏了哪一侧当场红；
只有「接口上刻意不开」的参数要进 `EXEMPT`（现在只有 `user_id`）。

⚠️ **别拿渲染出来的日期字符串做断言。** `TimeZone` 列类型会把带时区的入参
`astimezone()` 到 `DATETIME_TIMEZONE`，传 UTC 的 `2030-12-31 23:59:59` 渲染出来是
`2031-01-01 07:59:59+08:00`——按日期子串断言会把一次**正确**的时区换算误判成
「过滤没生效」。实测被自己坑过一次，现在断言的是绑定值。

## 权限码里不能有连字符

`test_permission_codes.py` 的种子扫描正则是 `'([a-z0-9_]+(?::[a-z0-9_]+)+)'`——
`ai:tool-log:list` 这种带连字符的码**扫不到**，于是"后端声明了但种子里没有"那条
断言会红，而报错完全不提是连字符的问题。现在用的是 `ai:log:list`。

## 🔴 确认令牌：先验归属、再用 `DELETE` 的返回值抢占

`chat_service.confirm_tool` 是变更类工具**唯一**的执行入口，两处原来都是静默错的：

| 症状 | 根因 | 修法 |
|---|---|---|
| 同一个确认被执行多次（双击 / 网络重试 / 两个标签页） | 「`GET` 到就算数、再 `DELETE`」不是原子的 | 以 `DELETE` 返回 1 为准，只有删到的那一个执行 |
| 别人拿到令牌试一次，本人点确认只看到「已过期」 | 先删令牌再比 `user_id` | 归属校验挪到抢占之前（只读不删） |

**实测证据**（`tests/test_ai_confirm.py`，真实 Redis）：修复前 5 个并发确认**执行了 5 次**；
陌生人试一次后本人得到 `confirm_expired`。修复后两条转绿，连跑 3 次稳定。

🔴 **竞态测试必须先预热连接池，否则假绿。** 第一版没预热就是绿的：冷池里第一个请求
复用 `SET` 留下的连接，其余的都在建新连接（connect + AUTH），等它们发出 `GET` 时
第一个早已读完删完。直接探针实测：冷池 5 个并发只有 1 个读到令牌，热池 5 个全读到。
**生产的连接池是热的**，测冷池等于测一个不存在的现实。

⚠️ 用真实 Redis 而不是 mock：竞态窗口就是「读」和「删」之间那两次网络往返，
mock 掉 Redis 就把窗口一起 mock 没了。

## 写操作工具：预演 → 确认 → 执行

现有两个变更类工具：`dept_create` / `dept_rename`（`tools/dept_tools.py`），删除刻意没开
（不可逆，且牵连下属部门与用户）。新增写操作工具照这四条：

- 🔴 **必须带 `preview`**，注册期强制（没有就 `TypeError`）。没有它，确认卡片上只剩
  「工具名 + 参数」——`dept_id: "2048…"` 对人什么都没说，「人点头」退化成走过场
- 🔴 **预演和执行共用 service 的同一份校验**（`dept_service.check_create / check_update`，
  `create / update` 内部也调它）。另写一份「预演用的校验」迟早漂移：预演说能做、执行说不能（人白点一次确认），
  或者预演说不能、执行其实能 —— 两种都不报错，只是人看到的和系统做的不是一回事
- **预演失败不发令牌**：dispatcher 先跑 preview，抛异常就直接回 `failed`（原因回给模型转告用户），
  不弹确认卡片。预演和执行都经 `_invoke`，**都在调用者的数据范围里跑** ——
  `dept_dao` 是 `DataScopedCRUD`，范围外的部门（含上级）对工具来说就是不存在
- **提交后动作挂 `ctx.background_tasks`**（如清用户缓存），由开会话的一方在 commit 之后执行；
  提交前清缓存，并发请求会把旧数据重新缓存回去

⚠️ 改名必须显式带原 `parent_id`：`UpdateDeptParam` 里它是可选的，漏传时 `check_update`
按「挪到顶级」去找同名兄弟，真正的兄弟查不到 —— 同一上级下出现两个同名部门，不报错。

**实测证据**（`tests/test_ai_write_tools.py`，真实测试库不提交 + 真实 Redis）：
建 → 改名往返、同级重名在预演拦住、受限范围用户改不到范围外部门（连伪造 `pre_approved` 也不行）。
**变异检验**三处各打红：去掉 `_rename_param` 的 `parent_id`（「改名撞同级兄弟」那条红）·
`_invoke` 去掉 `scoped_to_user`（范围那三条红）· 跳过预演（预演闸那几条红）。

⚠️ 测试会话是 `autoflush=False`，断言前要 `flush()`；结束要回滚，所以断言用的值得在会话里先取出来
（回滚后 ORM 实例失效，`DetachedInstanceError`）。

⚠️ 现在的预演是「会变成什么」的**一句话描述**，不是字段级 diff。改的字段多起来（改上级、改状态）
时再考虑结构化预览。
