---
title: AI 助手
description: 对话式 AI 助手：工具调用以当前登录人的身份执行，权限码和数据范围与界面一致；写操作先预演、本人确认才执行，每次调用都留审计。
sidebar:
  order: 4
---

AI 助手是一个对话入口（整页对话，外加一个在任何页面都能拉出来的侧滑抽屉），通过调用后端注册好的工具来回答问题、完成后台操作。每一次工具调用都以**当前登录的人**的身份执行：他有哪些权限码、能看到哪些数据行，AI 就只能动这些。写操作先给出预演，本人点「确认执行」才真正落库。每次调用（包括被拒绝的）都写进审计表；外部系统可以通过 MCP 网关调用同一套工具，走的是同一道检查。

## 在界面上哪里找？

| 入口 | 路径 | 说明 |
|---|---|---|
| **AI 助手 → 对话助手** | `/ai/chat` | 整页对话。当前会话 ID 写在地址栏（`?c=<id>`），刷新不丢 |
| 顶栏机器人图标 | — | 侧滑抽屉。**非模态**：抽屉开着时，下面的表格照样能点、能翻页，适合边看数据边问。`Esc` 关闭，宽度按设备记住 |
| **AI 助手 → 模型密钥管理** | `/ai/provider` | 模型供应商与 API Key |
| **AI 助手 → 调用日志** | `/ai/tool-log` | 每一次工具调用的审计 |
| **AI 助手 → MCP 凭据** | `/ai/mcp-client` | 发给外部系统的令牌 |

两个对话入口共用同一个 hook（[`use-chat-session.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/ai-chat/use-chat-session.ts)），行为一致，抽屉和整页可以停在不同的会话上。发起对话需要 `ai:chat:use` 权限，而且账号要有后台管理权限（`is_staff`）。对话接口是 POST，和全站其他写接口过同一道 RBAC 检查，所以这一条和别处一样。种子数据**刻意没有**把 AI 菜单授给任何非超管角色，哪些角色该有这个入口由每套部署自己决定。

:::note[在线演示]
[在线演示](https://fra.wubunan.com/sign-in)（`admin` / `123456`）里，这几个页面在「AI 助手」菜单下。模型密钥是每套部署自己配的，所以别指望演示环境一定能对话。没有配置供应商时，对话会明确提示「还没有配置可用的模型供应商」，而不是静默失败。
:::

## 支持哪些模型供应商？怎么配？

所有供应商都走 OpenAI 兼容的 `POST {base_url}/chat/completions` 流式接口。后端直接用 `httpx`，不依赖任何厂商 SDK（[`llm/client.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/llm/client.py)）。「类型」只影响预填的默认值：

| 类型 | 默认 `base_url` | 默认模型 |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 通义千问（DashScope） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 自定义 / 内网网关 | — | — |

每个供应商还可以设超时（1–600 秒，默认 120）、是否校验 TLS 证书（内网自签证书的网关要关掉，否则报 `SSLCertVerificationError`，看起来像网关挂了）、是否走系统代理（按网关的实际可达路径选，配错的表现是纯超时）。

对话用标记为「默认」的供应商，没有默认的就用任意一个启用的。「测试连通性」会真的发一句最短的对话，拿到第一帧就报延迟，走的就是 `/chat/completions` 这条实际要用的路。请求里带 OpenAI 格式的 `tools` 和 `tool_choice: "auto"`，所以网关后面的模型需要支持 function calling。

API Key 用 `AI_ENCRYPT_SECRET_KEY`（64 位十六进制，放 `.env`）做 AES 加密后落库。没配这个密钥时，保存供应商会**明确报错拒绝**，不会悄悄存成明文。接口响应里只有掩码（如 `sk-abc***xyz`），明文和密文都不出现。

```toml
# apps/api/backend/plugin/ai/plugin.toml（默认值）
AI_AGENT_ENGINE = "native"            # 或 "pydantic_ai"；两者走同一个 dispatcher
AI_CONFIRM_MUTATING_TOOLS = true      # 关掉 = 写操作不经确认直接执行
AI_CONFIRM_TOKEN_EXPIRE_SECONDS = 300
AI_MAX_TOOL_ROUNDS = 5                # 一轮对话里最多连续调用几轮工具
AI_CHAT_RATE_PER_MINUTE = 20          # 每人每分钟最多发几句（按人计，不按 IP）
AI_TOOL_DOMAINS = ["system", "role", "dept", "menu", "user", "log", "weather", "workflow"]
AI_MCP_ENABLED = false
```

`native` 是自己写的 OpenAI 兼容 function-calling 循环。`pydantic_ai` 把工具作为 external toolset 交给 pydantic-ai，框架自己**执行不了**这些工具。插件分册记录过一次实测：在跑 Qwen3-VL 的内网网关上，同样的问题两个引擎给出的工具调用序列逐条相同。

## AI 助手怎么保证不越权？

模型和驱动它的引擎都被当成**不受信任的建议者**：它们只能「提议」调用某个工具。能不能真的执行，只由 [`core/dispatcher.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/dispatcher.py) 一处决定。这是整个插件里唯一不可替换的一层：

1. **工具清单在交给模型之前就过滤好。** 用户没有某个工具的权限码，模型就根本不知道有这个工具。判据和 HTTP 接口的 RBAC 检查是同一套（[`rbac.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/security/rbac.py) 里紧挨着 `rbac_verify` 的 `user_has_perm`），写工具还额外要求 `is_staff`。插件被停用了，或者工具所在的域不在 `AI_TOOL_DOMAINS` 里，这些工具也不出现。
2. **执行时再查一遍。** 模型幻觉出来的工具名、对话中途被收回的权限、从只读入口发来的写操作，一律 `denied`，并记入审计。
3. **数据范围在每次调用时锚定。** 每个工具都在 `scoped_to_user(ctx.user)` 里执行，经 `DataScopedCRUD` 的查询只返回这个人能看到的行。这里不依赖「JWT 中间件反正会设好上下文」：MCP 这种不走 JWT 的入口一旦漏设，结果就是不加任何行过滤。见[数据权限](/features/data-permissions/)。
4. **引擎手上没有可执行体。** 引擎拿到的是 `ToolSchema`（名称、说明、JSON Schema、`mutating`），纯数据，不带 handler。`engines/` 目录下只要出现 `.handler` 或 import 了工具注册表，守卫测试当场红。

超级管理员本来就绕过权限码和数据范围，所以种子里的 `admin` 能看到全部工具。工具结果会回传给模型供应商，所以出门前要裁剪：结果超过 4000 字符就截断，`user_list` 最多回 30 行，而且不带邮箱和手机号。

## 写操作执行前会发生什么？

内置 23 个工具里有 12 个会改数据。每一个都要走下面几步：

1. 模型提议调用后，dispatcher 先在用户的数据范围里跑这个工具的**预演**。写工具必须带预演，注册时没有就直接 `TypeError`。预演和真正执行共用 service 层的同一份校验（如 `dept_service.check_create` / `check_update`），不会出现「预演说能做、执行说不能」这类两边对不上的情况。
2. 预演失败（部门不存在、不在你的数据范围里、同级重名……）就不弹确认卡片，原因回给模型，由它转告用户。
3. 预演通过后，生成一次性令牌（`cf_…`），连同工具、参数、用户、预演文案、来源渠道一起存进 Redis，有效期 300 秒。界面上弹出写着预演文案的确认卡片。
4. 用户点「确认执行」后，`POST /api/v1/ai/chat/tools/confirm` 会先核对令牌属于当前用户，再用 Redis 的原子 `DELETE` 抢占令牌，然后带着完整的权限检查再分发一次。卡片随即换成执行结果，没法再点第二次。

原子抢占是修一个真 bug 留下的：修之前，同一个令牌 5 个并发确认，变更被执行了 5 次。现在 [`tests/test_ai_confirm.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/tests/test_ai_confirm.py) 用真实 Redis、预热过的连接池证明只有一个能抢到。

:::caution
`AI_CONFIRM_MUTATING_TOOLS = false` 会去掉第 3 步，模型一调用写操作就直接执行。另外，**没有任何删除类工具**：删除不可逆，还会牵连下级、用户和角色授权。
:::

## 内置了哪些工具？怎么加一个？

| 域 | 只读 | 写（预演 + 确认） |
|---|---|---|
| system | `system_health_check`、`system_whoami` | — |
| user | `user_list` | — |
| dept | `dept_list` | `dept_create`、`dept_rename`、`dept_set_leader` |
| role | `role_list` | `role_create`、`role_rename`、`role_set_status`、`role_update_menus` |
| menu | `menu_list` | `menu_create`、`menu_set_status` |
| log | `login_log_list`、`opera_log_list` | — |
| weather | `weather_query` | — |
| workflow | `wf_todo_list`、`wf_instance_detail` | `wf_approve`、`wf_reject`、`wf_transfer` |

审批相关的工具放在审批插件自己的 [`ai_tools.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/ai_tools.py) 里，授权和网页上的审批按钮走同一个函数：在对话里能批的单，就是你在页面上能批的单。要加工具，在 `plugin/ai/tools/` 或你自己插件的 `ai_tools.py` 里给一个 async 函数加上 `@ai_tool`，两处都会被自动发现（[`core/registry.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/registry.py)）：

```python
@ai_tool(
    name='dept_rename',
    description='…',            # 写给模型看的：什么时候该用它
    domain='dept',
    perm='sys:dept:edit',       # 复用现有 RBAC 权限码，不另起一套授权模型
    mutating=True,
    preview=_preview_rename,    # mutating=True 时必填
)
async def dept_rename(db: AsyncSession, ctx: RunContext, dept_id: str, new_name: str) -> dict[str, Any]:
    ...
```

模型看到的 JSON Schema 从函数签名自动生成。`db`、`ctx` 由 dispatcher 注入，不暴露给模型。

## 审计里记了什么？

每次调用在 `ai_tool_invocation` 落一行：用户、会话、工具名、状态（成功 / 失败 / 被拒绝 / 待确认）、权限码、参数（按操作日志同一份 `OPERA_LOG_REDACT_KEYS` 打码）、结果摘要、错误、耗时和渠道（MCP 调用记作 `mcp:<client_id>`）。

「被拒绝」和「失败」**刻意分开**：有人反复让 AI 去做他没权限做的事，这件事要能单独查出来，不能淹没在普通报错里。

审计写入放在 SAVEPOINT 里：写失败只丢这一行审计，对话照常继续（[`test_ai_audit.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/tests/test_ai_audit.py) 实测）。在「AI 助手 → 调用日志」里查看，需要 `ai:log:list` 权限。对话界面上，每条回答的正文上方会列出它的工具轨迹（工具、权限码、成败、耗时），这份轨迹随消息一起落库，刷新后还在。

## 外部系统怎么通过 MCP 调用？

`/api/v1/ai/mcp` 是 MCP Streamable HTTP（无状态 + JSON 响应），**默认关闭**：`AI_MCP_ENABLED = false` 时返回 404。网关本身不执行任何东西：列工具走同一个过滤，调工具走同一个 dispatcher，权限、数据范围、审计和网页对话完全一致。凭据在「AI 助手 → MCP 凭据」里发，`fra_mcp_…` 令牌只显示一次，库里只存 SHA-256。

```http
POST /api/v1/ai/mcp
Authorization: Bearer fra_mcp_<token>
X-Acting-User: <用户名>
```

代表谁是外部系统**自己声明**的，所以网关只信到「这份凭据被允许代表谁」为止（[`mcp_gateway/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/mcp_gateway/auth.py)）：

- **`act_as` 白名单**：这份凭据能代表哪些用户名（`*` = 任何普通用户）。代表超管必须显式打开 `allow_superuser`。
- **和登录同一套用户校验**：账号停用、部门停用、角色全停用的人，经 MCP 也代表不了。
- **默认只读**：开了 `allow_write` 之后，写工具也只做预演，返回一个 `AI_WEB_BASE_URL/ai/confirm?token=…` 链接，必须由被代表的那个人本人登录网页点确认。别人打开这个链接只会得到 403。
- **可选的 `tools` 白名单**：只能收窄，不能放大。
- **按凭据限流**：默认每分钟 120 次，超了回 429 + `Retry-After`。按 IP 限的话，同一个外部系统背后的所有人挤一份额度；按被代表的用户限的话，一份泄露的令牌轮换着代表不同的人，就能不断拿到新额度。

凭据停用、删除、重新生成都在下一个请求就生效（每次现查，不缓存），停用 AI 插件也会一并关掉网关。插件分册记录过一次实测（起真实 uvicorn，用官方 `mcp` Python 客户端连）：代表 STAFF 账号调 `dept_list` 被拒；白名单外的用户在 HTTP 层就是 403；4 次调用对应 4 行 `channel=mcp:e2e` 审计；额度设成 5 时连发 7 次，结果是 5 × 200、2 × 429（`Retry-After: 60`）。

## 有哪些开关？

各页面的权限码：对话 `ai:chat:use` · 模型密钥管理 `ai:provider:list` / `add` / `edit` / `del` · 调用日志 `ai:log:list` · MCP 凭据 `ai:mcp:list` / `add` / `edit` / `del`。AI 插件没有放进参数配置页的项，下面全部在 `.env` 改（写在 `plugin/ai/plugin.toml` 的 `[settings]`），改完重启后端：

| 键 | 默认值 | 说明 |
|---|---|---|
| `AI_ENCRYPT_SECRET_KEY` | 空 | 供应商 API Key 落库加密用；留空 = 拒绝保存密钥，不存明文 |
| `AI_AGENT_ENGINE` | `native` | `native`（零额外依赖）或 `pydantic_ai`；权限、确认、审计不随引擎变 |
| `AI_CONFIRM_MUTATING_TOOLS` | `true` | 写操作是否要本人确认；关掉 = 模型一调用就执行，谨慎 |
| `AI_CONFIRM_TOKEN_EXPIRE_SECONDS` | `300` | 确认令牌的有效期 |
| `AI_MAX_TOOL_ROUNDS` | `5` | 一句话里最多连续调用几轮工具 |
| `AI_CHAT_RATE_PER_MINUTE` | `20` | 每人每分钟最多发几句（按人计，不按 IP） |
| `AI_TOOL_DOMAINS` | `system` · `role` · `dept` · `menu` · `user` · `log` · `weather` · `workflow` | 开放给 AI 的工具域；注册了但不在这里的不会出现在工具清单里 |
| `AI_MCP_ENABLED` | `false` | MCP 网关总开关 |
| `AI_MCP_RATE_PER_MINUTE` | `120` | 每份 MCP 凭据每分钟的请求上限（按凭据计） |
| `AI_WEB_BASE_URL` | `http://localhost:8888` | MCP 发起的写操作让本人确认时拼的地址，**上线前改成真实域名** |
| `AI_EXTERNAL_HTTP_TIMEOUT` · `AI_EXTERNAL_HTTP_USE_PROXY` | `15` · `true` | 外部 HTTP 工具（如天气）的超时，是否走环境里配的代理 |

## 它不做什么？

- 没有删除类工具。也没有「改菜单名」：菜单名按语言走翻译，做成工具的话卡片会说改好了，英文界面却没变。
- 预演是一句话描述，不是字段级 diff。
- 每句话最多 `AI_MAX_TOOL_ROUNDS`（5）轮工具调用。native 引擎不做长会话的上下文压缩。
- MCP 发起的写操作只在网页上确认，不接受 MCP 客户端代答。

## 怎么测的？

后端测试打真实测试库和真实 Redis。下表按 `def test_` 函数计数，参数化展开后条数更多。

| 文件 | 数量 | 覆盖 |
|---|---|---|
| `test_ai_security.py` | 28 | 权限判据一致、数据范围锚定、引擎不持有可执行体、密钥不进响应、流式解析 |
| `test_ai_mcp.py` / `test_ai_mcp_clients.py` | 21 / 8 | 网关鉴权、`act_as`、只读、限流、凭据生命周期 |
| `test_ai_write_tools.py` / `test_ai_role_menu_tools.py` | 11 / 10 | 写完读回库里断言、受限数据范围的用户 |
| `test_ai_pydantic_engine.py` | 10 | 第二个引擎，与 native 事件序列一致 |
| `test_ai_confirm.py` · `test_ai_audit.py` · `test_ai_chat_limit.py` · `test_ai_read_tools.py` | 3 · 1 · 1 · 2 | 令牌竞态、审计隔离、429、每个只读工具真跑一遍 |
| `plugin/workflow/tests/test_ai_workflow_tools.py` | 12 | 在对话里同意 / 驳回 / 转交 |

多数守卫在插件分册里都记了变异检验：拿掉那道检查，对应测试当场变红。Playwright 用例 `ai-chat-confirm.spec.ts`、`ai-chat-limit.spec.ts` 用 `page.route` 固定 SSE 返回，CI 不调用真实模型。

## 代码在哪

- [`plugin/ai/core/dispatcher.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/dispatcher.py)：权限过滤、数据范围、二次确认、审计
- [`plugin/ai/core/registry.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/core/registry.py)：`@ai_tool`、从签名生成 schema、自动发现
- [`plugin/ai/service/chat_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/service/chat_service.py)：SSE 对话与确认执行
- [`plugin/ai/engines/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/ai/engines) · [`plugin/ai/tools/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/ai/tools) · [`plugin/ai/mcp_gateway/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/ai/mcp_gateway)
- [`plugin/ai/plugin.toml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/plugin.toml)：全部配置项及注释
- [`packages/platform/src/pages/ai-chat/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/ai-chat)：对话页、抽屉、确认卡片
- [`plugin/ai/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/ai/AGENTS.md)：设计取舍与实测踩坑记录
