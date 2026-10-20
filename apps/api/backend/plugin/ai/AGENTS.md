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

## 两个引擎：`native` / `pydantic_ai`

`AI_AGENT_ENGINE` 切换，两者走同一个 dispatcher。`pydantic_ai` 把工具以 `ExternalToolset`
交给框架（框架**执行不了**它们），模型提议的调用经 `HandleDeferredToolCalls` 交回
`tool_dispatcher.dispatch`；`confirm_required` 不回填结果，框架冒泡结束这一轮。
四个实测坑和对应处理写在 `engines/pydantic_ai_engine.py` 开头那张表里。

**实测证据**（`tests/test_ai_pydantic_engine.py`，框架自带的 `FunctionModel`，不连网关）：
11 条，其中「同一段对话两个引擎的事件序列一致」两条。**变异检验**：四个坑各撤掉一处
处理，对应测试各自转红；在新引擎里写一句 `get_tool(...).handler(...)`，
`TestEnginesNeverHoldExecutables` 当场红并指出行号。
真实网关（Qwen3-VL，内网）上两个引擎各跑「查健康 + 部门」「在总部下新建部门」：
工具调用序列逐条相同，新建都停在确认卡片上。

⚠️ pydantic-ai 2.57 要求 Python ≥ 3.11，3.10 上 uv 会解析到 2.54（`pyproject` 下限因此是 2.54）。
两版之间 `AgentRunResult.usage` 从方法改成了属性，适配器两种都接；**3.10 那条没有实跑过**
（CI 和生产镜像都是 3.13）。

## 🔴 只读工具要真跑一遍：service 签名会被别的 PR 改掉

#108 删了 `DeptService.get_tree()` 的 `leader` 参数、把部门的 `leader` 改成 `leader_id`；
#105 在它之后合并，两个 PR 各自 CI 全绿，合起来：

| 工具 | 表现 |
|---|---|
| `dept_list` | 每次 `unexpected keyword argument 'leader'`。模型拿着参数错误重试到 5 轮上限，报「请把问题拆小一些」—— 像模型笨，不像代码坏 |
| `dept_create` | **静默**：pydantic 丢掉未知字段 `leader`，确认卡片写着「负责人：张三」，建出来没有负责人 |

`test_ai_read_tools.py` 把每个只读工具在真实测试库上跑一遍（修复前 `dept_list` 实测红）。
负责人后来按名字补回来了，见下面「负责人：名字 → 用户 ID」。
⚠️ 「工具参数 → schema 字段名」这一类静默丢弃，只读冒烟测试抓不到 —— 写操作工具要像
`test_ai_write_tools.py` 那样建完读回来断言。

## 🔴 审计写失败，必须只坏审计那一行

`_audit` 原来只 `try/except` 吞异常。吞掉的是 Python 异常，**会话已经坏了**：flush 失败后
SQLAlchemy 把整个事务标成待回滚，这一轮对话里后面每个工具都 `PendingRollbackError` →「执行失败」。
现在放进 `begin_nested()`（SAVEPOINT）。

**实测证据**（`tests/test_ai_audit.py`）：用一个名字超过列宽的工具触发真实的数据库报错，
修复前同一会话里下一个 `dept_list` 失败、连计数查询都 `PendingRollbackError`；修复后通过，
且后面的审计照常写入。最早是脚本里没初始化雪花算法时撞到的（审计取不到 ID）。

## MCP 网关（`/api/v1/ai/mcp`，只读）

第二个入口：外部系统（pis-agent、Claude Desktop、Cursor…）以 MCP Streamable HTTP（无状态 + JSON）
调 `@ai_tool`。**它不执行工具**：清单走 `visible_schemas()`，调用走 `dispatch()`，
和网页对话同一份权限 / 数据范围 / 审计。开关在 `plugin.toml` 末尾；凭据在「AI 助手 → MCP 凭据」页里发（`ai_mcp_client` 表）。

🔴 **身份是外部系统声明的**（M2M 凭据 + `X-Acting-User`），所以只能信到「这个凭据被允许代表谁」：

| 闸 | 在哪 | 不做的后果 |
|---|---|---|
| 凭据只存 sha256，按哈希等值查（比对的是哈希，时间泄露不出明文） | `auth.py` | 库 / 配置泄露 = 凭据泄露 |
| `act_as` 白名单 | `auth.py` | 一份凭据能代表全公司任何人 |
| **默认不能代表超管**（`allow_superuser` 显式开） | `auth.py` | 泄露的凭据 + `X-Acting-User: admin` = 整个系统 |
| 用户走 `get_jwt_user()` | `auth.py` | 网页上登不进来的人（停用账号 / 部门 / 角色）经 MCP 照样能被代表 |
| 写操作拒绝 —— **拦在 dispatcher**（`ctx.read_only`），不只拦在网关 | `core/dispatcher.py` | 清单里不出现不等于调不到：外部系统可以直接调名字；拦在网关的话下一个入口还得再记一遍，而且拒绝不进审计 |
| 凭据级 `tools` 白名单只能收窄 | `server.py` | —— |
| 审计带 `channel = mcp:<client>` | 迁移 `h0000000aichannel` | 出了事只查得到「张三调的」，查不到是哪个系统替他调的 |

三条装配上的坑（都是实测出来的）：

- 🔴 **必须进 JWT 中间件的放行名单**（`hooks.py`）。外部系统的 Bearer 不是 JWT，不放行会被中间件当坏
  token 先拒掉（401「Token 无效」），请求到不了网关
- 🔴 **用精确路径的 `Route`，不用 `app.mount`**：mount 下不带斜杠的 URL 被 307，MCP 客户端多数不跟重定向
- 🔴 **会话管理器要由插件 `lifespan` 拉起**：mount / Route 进来的子应用的 lifespan 不会执行。
  SDK 的 DNS rebinding 防护默认只认 localhost 的 Host 头，部署到域名会 421 —— 每个请求都要
  Bearer，所以关掉
- 鉴权在外层 ASGI 做完，结果放 `scope['state']`，处理函数读 `ctx.request.state`。不用 ContextVar：
  MCP 处理函数跑在会话管理器自己的任务组里

**实测证据**：
- `tests/test_ai_mcp.py` 14 条，全走真实 HTTP + 测试库。**变异检验** 7 处各打红：dispatcher 不拦只读 ·
  清单不滤写工具 · 网关 `read_only=False` · 调用不查凭据白名单 · 不拦超管 · 不查 `act_as` ·
  不放行 JWT 中间件（这一条红 11 条）
- 起真实 uvicorn（连 `fba_test`），用**官方 `mcp` Python 客户端**连：代理 `admin` 看到 9 个只读工具、
  `dept_list` 返回真数据（ID 是字符串）、`dept_create` 被拒并提示回网页端；代理 `test`（STAFF）只有 3 个、
  调 `dept_list` 被拒；白名单外的 `zhangwei` 在 HTTP 层 403。4 次调用对应 4 行 `channel=mcp:e2e` 审计
- 装配坑也各撤一次验过：去掉插件 `lifespan` → `RuntimeError: Task group is not initialized`；
  打开 DNS rebinding 防护（只认 localhost）→ `421 Invalid Host header`

### 限流：按凭据，不按 IP、不按代理用户

`AI_MCP_RATE_PER_MINUTE`（默认 120），凭据里 `rate_per_minute` 可单独覆盖；超了在 HTTP 层 429 + `Retry-After`，
不进协议层。复用全站的 `utils/limiter.py: RateLimiter`，所以同样受 `REQUEST_LIMITER_ENABLED` 管
（测试里默认关，验 429 用 `rate_limiter` fixture）。

| 按什么计 | 为什么不行 |
|---|---|
| IP | 外部系统从一台机器代表很多人来调，所有人挤一份额度 |
| 代理用户 | 一份泄露的凭据轮换着代表不同的人，每换一个人就是一份新额度 |

**实测证据**：`TestRateLimit` 3 条，**变异检验** 3 处各打红（不限流 · 按代理用户计 · 所有凭据共用一份）。
真实 uvicorn 上额度 5：连发 7 个，5 × 200、2 × 429（`Retry-After: 60`）。
⚠️ 测试要用唯一的凭据 ID：计数窗口在 Redis 里活一分钟，固定 ID 会让上一轮的计数漏进这一轮。

### 凭据管理（`ai_mcp_client` 表 + 「MCP 凭据」页）

最早凭据写在 `.env`（`AI_MCP_CLIENTS`），改成表 + 管理页，**只留这一处**（两处并存迟早一边被忘）。
发凭据不用改配置重启；停用 / 删除 / 重新生成都**即刻**生效 —— 网关每个请求按哈希现查，不缓存。

- 🔴 **明文令牌只出现在新建 / 重新生成那一次响应里**，字段名 `mcp_token` 进了
  `OPERA_LOG_REDACT_KEYS`。不进的话操作日志把 JSON 响应体原样落进 `sys_opera_log.response_body`
  —— 永久，而且那张表有自己的查看权限（同用户导入那条）
- 详情 / 列表里**连哈希都没有**，只有 `token_hint`（前几位）给人辨认
- 存之前就校验：`act_as` 里的用户名必须存在、`tools` 里的工具必须存在且**不能是写操作工具**。
  写错能存进去的话，表现是外部系统一律 403 / 某个工具永远调不到，看起来像「凭据坏了」
- 令牌弹窗里的接口地址按 `API_BASE` 拼，不用 `window.location.origin`：开发期前后端不同端口，
  用页面地址会给出一个对方连不上的 URL（浏览器验收时看到的）

**实测证据**：`tests/test_ai_mcp_clients.py` 13 条 + `test_ai_mcp.py` 改为经管理接口真实建凭据（19 条，
新增停用 / 换令牌 / 删除即刻失效三条）。**变异检验** 6 处各打红：日志不打码 `mcp_token` · 详情带出哈希 ·
白名单放行写工具 · 不记最近使用时间 · 停用的凭据照样能用 · 换令牌不换哈希。
迁移 `i0000000aimcpcli` 在 `fba_test` 上 up → down → up，表和 5 条菜单都随之出现 / 消失。
浏览器全流程 11 项（侧边栏入口 → 新建 → 令牌弹窗 → 用令牌调 MCP → 白名单生效 → 最近使用更新 →
重新生成后旧令牌 401 → 删除后 401）全过；截图里发现并修了两处：菜单图标 `mdi:api` 没在
`shell/icon-registry.tsx` 登记（显示成空心小圆点）、接口地址用错了端口。

### 写操作：外部系统只能发起，本人在网页确认才执行

凭据默认只读；开了 `allow_write`，写工具会出现在清单里（`readOnlyHint: false`），但调用**只预演、不执行**：
网关返回预演文案 + `AI_WEB_BASE_URL/ai/confirm?token=…`，由外部系统转告用户。被代表的那个人本人登录网页、
在确认页点「确认执行」，才走 `chat_service.confirm_tool` 真正执行。

- 🔴 **确认必须回到我们自己的网页。** MCP 规范的 elicitation form 模式是客户端问用户 —— 客户端可以代答，
  我们验证不了是人点的。网页确认要求那个人的登录会话：外部系统**声明**的身份，到这一步才被本人兑现
- 确认令牌里存了 `channel` 和 `preview`：确认页读得出「会变成什么」，执行那行审计仍记作 `mcp:<client>`
- `GET /ai/chat/tools/confirm/{token}` 只读、不消费令牌，**只给令牌主人看**（链接会经过外部系统、
  聊天记录，别人拿到只得到 403，看不到预演）
- 被代表的人没有 `ai:chat:use` 就点不了网页确认 —— 网关提前拒绝并说明，不发一个永远点不了的链接
- 🔴 **确认令牌带字母前缀 `cf_`。** 令牌会进网页链接的 search，而路由层对 search 值跑 `JSON.parse`
  （`apps/web/src/lib/search-params.ts` 只把「超安全范围的纯整数」保成字符串）。纯十六进制恰好只含
  数字和一个 `e` 时（`123e4567…`）会被解析成数字，确认页拿到的令牌就不对 —— 表现是一句查不出原因的
  「已过期」。实测 `JSON.parse('123e45')` 是 number
- 确认页把 403 / 404 当终态：只给说明、不给「重试」（令牌一次性，重试永远不会成功）

**实测证据**：`TestWriteViaWebConfirm` 4 条（MCP 只预演库里不多东西 → 查看预演不消费 → 网页确认才建出来、
审计 channel 对 · 别人的令牌 403 且看不到预演 · 无 `ai:chat:use` 不发链接 · 写工具只在开了 allow_write 时上清单）。
**变异检验** 5 处各打红：没开写权限也放行到确认 · 预演接口不验归属 · 确认时丢 channel · 不预检 `ai:chat:use` ·
令牌不带前缀。浏览器全流程 6 项通过（MCP 返回链接 → 确认页显示预演和来源 → 点确认 → 部门建出 → 再开同一链接提示已处理）。

## 负责人：名字 → 用户 ID（`dept_create` 的 `leader` · `dept_set_leader`）

人说的是名字，库里存的是 `leader_id`。`tools/dept_tools.py: _resolve_leader`：

- 🔴 **只在调用者的数据范围里找**（走 `user_dao.select_models`，`DataScopedCRUD`）：看不见的人设不了，
  也不会因为「找到了」泄露「这个人存在」
- 🔴 **重名不猜**：两个「张伟」时挑一个 = 把部门交给用户没指的人，而确认卡片看着完全正常。
  抛错并列出候选（带用户名），模型回去问
- 停用账号不算（同 `dept_service._check_leader`：审批按负责人取人时停用的等于没配）
- 🔴 **工具描述里要明说「不要先用 user_list 查」**。真实模型（Qwen3-VL）会先用 `user_list`
  按**用户名**搜「张伟」——那是昵称，搜不到就断定用户不存在、不调工具；而工具自己按用户名**或**昵称找

**实测证据**：`test_ai_write_tools.py::TestDeptLeader` 7 条，**全部读回库里的 `leader_id`** 断言
（只看预演文案和 `ok` 的测试，对上次「卡片写着负责人、库里没有」那个 bug 是绿的）。
**变异检验** 5 处各打红：建部门丢 `leader_id` · 绕过数据范围查人 · 重名挑第一个 · 不排除停用账号 ·
换负责人不写 `leader_id`。真实网关上「新建并指定张伟 → 换成李娜」两步，卡片文案和库里的值都对；
加那半句描述之前，同一句话模型停在「用户张伟未找到」。
