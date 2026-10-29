# plugin/open —— 能力开放（AK/SK 签名的只读开放接口）

> 应用级插件（`[app] router = ["open_v1", "v1"]`）：管理接口在 `/api/v1/open-apps`、`/api/v1/open-api-logs`，
> 开放接口在 `/api/open/v1/*`。设计、取舍和否掉的方案见 issue #118；对接方看的文档是同目录的 `README.md`。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

```
gateway/signature.py  FRA1-HMAC-SHA256 的服务端那一半（规范化查询串 · 待签名字符串 · 常量时间比对）
gateway/auth.py       DependsOpenApp：验签 → nonce → scope → 限流；scope 注册表 SCOPES
gateway/route.py      OpenApiRoute：每次调用落一条 open_api_log（成功失败都落）
sdk/                  对接方拷走的参考实现（Python / Node / Java）+ test_vectors.json
events.py             Webhook 事件目录（#167）：内置用户 / 部门事件 + 扫各插件的 webhook_events.py
service/event_service.py     事件产生：事务内写 open_event + fan-out 投递行 + 提交后踢 worker
service/webhook_delivery.py  投递：抢占 → SSRF 检查 → 签名 POST → 记一次尝试 → 退避 / 自动停用
service/webhook_sign.py      出站签名（Standard Webhooks），和三份 SDK 的 verify_webhook 对同一组向量
```

## 🔴 新增一个开放接口要做的三件事

1. 挂 `dependencies=[Depends(DependsOpenApp('<scope>', '<中文名>'))]`，路由器用 `APIRouter(route_class=OpenApiRoute)`。
   **漏挂鉴权的那个接口不用签名、谁都能调**，而且 JWT 中间件也放行它（没带 Bearer 是「未认证」不是「认证失败」）。
   守卫：`tests/test_open_api.py::TestEveryOpenRouteIsGuarded`
2. 返回值用**专门的对外 schema**（`schema/open_v1.py`），只放承诺给对方的字段，ID 一律 `str`。
   内部 schema 加字段不能跟着外泄
3. 接口的 `summary` 和 scope 中文名进前端语言包 + `server-data-keys.json`（调用日志页、勾选框都是 `t(变量)` 渲染）

## 🔴 FastAPI 0.141 起 `app.routes` 看不见子路由

`include_router` 不再把子路由摊平，而是包成一层 `_IncludedRouter`。实测 `app.routes` 里 `APIRoute` 只有 **2** 个
（两个 health），而全站实际有 **208** 个。照老写法遍历 `app.routes` 找开放接口，scope 清单和导出的 OpenAPI 文档
**会静默变成空的**，不报错。要用 `fastapi.routing.iter_route_contexts(app.routes)`（`get_openapi` 自己也用它），
见 `service/app_service.py: open_routes()`。

⚠️ 同一个坑在仓库里已有一处没修：`utils/openapi.py` 的 `simplify_operation_ids` / `ensure_unique_route_names`
也是遍历 `app.routes`，于是 operationId 一直没被简化（实测还是 `login_api_v1_auth_login_post`），
路由重名检查只查了 2 个路由。修它会改动 `gen:api` 生成的类型，单独处理。

## 🔴 plugin.toml 的配置项要在 `core/conf.py` 里声明成字段

只写在 `plugin.toml` 里的配置是 `Settings` 的 extra，**进程环境变量覆盖不了**（`env_settings` 只认声明过的字段）。
浏览器验收时真撞上：用环境变量传了 `OPEN_SECRET_KEY`，新建应用照样报「未配置 OPEN_SECRET_KEY」——
部署时用容器环境变量配密钥就是这个下场。守卫：`test_every_plugin_setting_is_a_declared_field`
（变异检验：删掉 `OPEN_SECRET_KEY` 的声明，红）。

## 鉴权顺序：先验签、后消费 nonce

和 #118 表里的顺序相反，刻意的：签名不对的请求不该占掉一个 nonce —— 否则对方签错一次、修好之后用同一个 nonce
重发，会被当成重放拒掉，对接时极难理解。真正的重放签名一定是对的，照样撞上 nonce 那一步。
守卫：`test_bad_signature_does_not_burn_the_nonce`（变异检验：把消费 nonce 挪到验签前，红 11 条）。

## 🔴 增量同步的静默坑

- 变更时间用 `COALESCE(updated_time, created_time)`：`DateTimeMixin.updated_time` 可空，新插入的行是 NULL，
  只按它查会**漏掉所有新增**
- 软删的行也要返回（`deleted: true`），所以 `service/sync_service.py` **直接写 select、不走 DAO**
  （DAO 的查询都带着 `deleted = 0`）
- 游标比较展开成 `t > :t OR (t = :t AND id > :id)`，不写行值比较 —— SQL Server 不支持
- 🔴 **SQL Server 上时间要先 `CAST(... AS DATETIMEOFFSET(6))` 再取、比、排**：`datetimeoffset(7)` 存到 100ns，
  Python `datetime` 只到微秒。库里生成的时间（种子的 `GETDATE()`，1/300 秒一跳，`.3833333` 这种）读出来被截成
  `.383333`，游标里的 `t` 比真值小一点点，`t > :t` 对**同一行**永远成立 —— 同一页、同一个 `next_cursor` 无限返回，
  对方的同步循环停不下来。应用自己写的时间（`timezone.now()`）只到微秒，所以只有种子 / 库默认值踩得到；
  `GETDATE()` 落在 `.xx0` 毫秒时恰好没有第 7 位，于是是**三分之二概率**的偶发

**实测证据**（第 7 位那条）：CI 的 `pytest · SQL Server` 挂满超时三次，本地复现在 58%，faulthandler 栈停在
`_drain` 的 `while True`；当时测试库里种子部门的时间是 `02:01:41.3833333`。`test_sub_microsecond_timestamps_do_not_stall_the_cursor`
把三行写成同一个带第 7 位的时间、`limit=1` 翻页。变异检验：去掉 CAST，这条和 `test_paging_is_complete_and_has_no_duplicates`
一起红（`_drain` 现在会断言游标前进，不再挂死）；加回来 SQL Server / PostgreSQL 各 43 条全过。

**实测证据**：`TestIncrementalSync` 经真实接口建一个部门 → 从「当前末尾」游标往后同步能拿到它（`updated_time` 为空）→
经真实接口删掉它 → 再往后同步拿到 `deleted: true`。变异检验：改成只按 `updated_time` 红 2 条、加上 `deleted == 0` 红 1 条。
（软删走的是 Core `update`，`updated_time` 的 `onupdate` 照样生效 —— 这条测试顺带验证了它。）

## 调用日志：不复用操作日志

`OperaLogMiddleware` 只记 `path.startswith(FASTAPI_API_V1_PATH)` 的请求（读代码），`/api/open/v1` 进不去；而对接时最要看的
失败原因多发生在识别出应用之前。所以单独一张 `open_api_log`，由 `gateway/route.py` 在路由类里落：

- 🔴 **脱敏 / 截断 / 取参直接调 `OperaLogMiddleware` 的静态方法**，不另写一份：两份脱敏规则迟早一边漏改
- 鉴权失败（`OpenApiError`）**在路由内转成响应**，不交给全局异常处理器 —— 这样日志拿得到最终响应体
  （签名不匹配时里面的 `string_to_sign` 是详情页排查的依据）
- 落库挂在响应的 `BackgroundTask` 上，自己开会话 → `service/api_log_service.py` 登记在
  `backend/conftest.py: _PATCHED_SESSION_MODULES`（不登记的话测试往开发库写日志）
- `x-sign` **不打码**（一次性签名，nonce 已消费，不能重放），留着和服务端的签名比对；SK 本来不过网
- 清理：挂在 `maintenance.prune_logs` 上，和登录 / 操作日志**同一个保留期**（`days` 参数，种子里是 30）

## 两个模型 / 迁移的坑

- 🔴 **写了 `__table_args__` 就要显式带 `{'comment': …}`**：docstring 自动变表注释那一步会被它覆盖。
  实测：独立库上 `create_all` → 删表 → 跑迁移 → `compare_metadata`，报出 `remove_table_comment('open_app')`。
  comment-only 的差异 `test_model_matches_migrations` 是放过的，所以只有这样验才看得见
- **迁移 `k0000000openapp` 和 PR #119 的 AI 预审迁移原来都从 `j0000000aimcpwrite` 分出**：#119 合并前改接到了当时的
  head 后面，revision ID 也一起换了（现在是 `p0000000wfaireview`）。为什么要换 ID，见 [`alembic` 分册](../../alembic/AGENTS.md)

**实测证据**：独立库 `fba_open_scratch`（PostgreSQL）上 up → 与模型比对零差异 → down（两张表和 8 条菜单都消失）→ up。
SQL Server / MySQL 只过了离线编译守卫（`test_migrations_compile_offline_for_every_supported_dialect`），没在真库上跑。

## nginx 不能改写 `/api/` 的路径

签名里的 PATH 是请求行里的原样路径。现在 `apps/web/nginx.conf` 的 `proxy_pass http://api:8000;` 不带 URI，
路径原样透传；**谁给它加上 URI 或 rewrite，所有开放接口的签名都会对不上**，报的是一句看不出原因的「签名不匹配」。

## Webhook 事件订阅（#167）

业务事件从 service 层出口：`backend/common/domain_events.py: emit(db, type, ...)`，在**调用方的事务里**写一行
`open_event` + 按订阅 fan-out 成 `open_webhook_delivery`（pending），提交之后 worker（`open.webhook_deliver_pending`，
每 15 秒 + 被踢）签名 POST 出去。投递内核的形状照抄通知投递（`plugin/notification`），**刻意没有抽成共用代码**：
两边的状态机不一样（Webhook 没有「结果未知」，见下），共用一份就得在里面分叉。

### 🔴 漏一处 `emit` = 那类变更对方永远收不到，不报错

出口现在有 11 个点：`user_service` 的建 / 改 / 启停 / 删 + 自助改昵称 / 邮箱 / 手机号 · 批量导入（`dataio.py`，和建号同一个保存点）·
第三方登录首次建号（`oauth2_service`）· `dept_service` 的建 / 改 / 删 · 审批的发起和五种终态（`runtime_service._emit_instance`）。
**新加一条会改用户 / 部门 / 审批状态的写路径，要在这里出口。** 守卫只管得了「写了的 type 在目录里」（AST 扫，
`test_every_emitted_type_is_registered`），管不了「该写没写」—— 那要靠 `test_dept_lifecycle_emits_every_step` /
`test_user_lifecycle_emits_every_step` 这种走真实接口的测试，新路径照着加一条。

⚠️ 事件里的值**写完之后重新查一遍**（`emit_user_event` / `emit_dept_event`），不拿手里的 ORM 实例：`dept_dao.update`
是 Core UPDATE，实例上还是旧值。变异：把部门事件的 `name` 换成别的列 → `test_dept_change_reaches_the_endpoint_signed` 红。

### 🔴 签的字节和发的字节必须是同一份

`open_event.payload` 就是请求体原文：生成一次、签它、发它，重试也发它。中间再 `json.dumps` 一次，界面上**照样显示成功**
（对方收到、回了 200），只是对方的验签全部失败、把每条事件都丢掉。E2E 在接收端按规范自己算一遍签名
（`apps/web/e2e/tests/webhook.spec.ts`）。变异：发送时 `json.dumps(json.loads(body))` → E2E 红在验签那句。

### 🔴 和通知投递相反：没有「结果未知」，停在发送中的改回失败重发

通知那边「停在 sending」= 可能已经发出去了，重发就是重复的一封邮件，所以归成「结果未知」不重试。
Webhook 是**至少一次**投递，对方按 `webhook-id` 去重（规范原文），所以超时 / 停在 sending 的一律按失败重试。

### 🔴 SSRF：保存时查一次，每次尝试前再查一次，不跟随重定向

URL 只收 https（`ENVIRONMENT=dev` 或开了 `OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK` 时放行 http），主机名**每次尝试前**都解析，
任何一个地址不是公网（`ipaddress.is_global` 为假：回环 / 私网 / 链路本地 / CGNAT / IPv4 映射的 IPv6…）就拒。
只在保存时查不够：域名之后可以改解析。3xx 一律当失败、不跟随 —— 跟随就是给 `169.254.169.254` 开门。

残余风险是 DNS 重绑定（检查时公网、连接时内网），一期不做「按解析出的 IP 连接 + 自带 Host/SNI」，部署层的缓解见
[`deploy` 分册](../../../../../deploy/AGENTS.md)。`OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK` 只给本地联调和 E2E，
**prod 启动检查会拒绝它**（`_check_webhook_private_network`）。

### 自动停用要「次数 + 24 小时」两个条件

只按次数的话，对方夜里重启十分钟、正好赶上一批事件，就会被当成死端点。410 Gone 立即停用。停用时给应用创建人发一条
`open.webhook.disabled` 通知（站内必发、邮件默认发）。重新启用清零连续失败。测试事件（ping）不计入、不重试 ——
管理员在界面上等结果，重试只会让「失败」变成几小时后才冒出来的一行。

### 读配置不走 Redis 缓存

`webhook_settings(db)` 直接查 `sys_config`：`emit` 在业务事务里跑、投递在 Celery 里跑、清理任务的测试在 `asyncio.run()` 的
一次性循环里跑，走 `load_config` 的 Redis 缓存会把共享连接池绑到那个随后就关掉的循环上（#169 的 CI 两个方言都红在这上面，
见 [`notification` 分册](../notification/AGENTS.md)）。

### `workflow:read` 是没有开放接口的 scope

由审批插件的 `webhook_events.py` 用 `register_scope()` 登记，只用来授权订阅审批事件。它要在**路由加载时**就在 `SCOPES` 里
（应用的勾选框和保存校验读它），所以 `api/router.py` 在 import 时调了一次 `load_webhook_extensions()`；
Celery 侧由投递任务自己调（短信插件那条「worker 不 import 路由」的坑）。

**实测证据**：`tests/test_webhooks.py` 41 条 + `test_open_signature.py` 里三份 SDK 的验签（Node / Java 真跑，没装就跳过）
+ `app/task/tests/test_prune_logs.py` 清理一条 + E2E `webhook.spec.ts`。签名对上了 Standard Webhooks 规范 README 里的示例
（`v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`，逐字一致）。13 处变异各有测试变红：跟随重定向 · 去掉 scope 检查 ·
自动停用只看次数 · ping 也重试 · 抢占不看状态（两个 worker 都发）· 不踢 worker · 轮换期只签新密钥 · 发送前不再查 SSRF ·
410 不停用 · 改部门 / 停用用户 / 审批结束不发事件 · 发 ORM 实例上的旧值。迁移 `ac000000webhook`：PostgreSQL 在开发库的副本上
up → down → up（4 张表 / 7 个按钮 / 5 行参数 / 1 条调度，down 后全为 0）；SQL Server 在 `fba_test` 上 down → up → down → up，
新表的主键 `sys.identity_columns` 0 行。本插件的测试在 SQL Server 上也跑过（失败的那一条是 main 上就有的，见下）。
MySQL 只过了离线编译守卫。**没验过**：真实公网接收端（只用过 `httpx.MockTransport` 和 E2E 里本机起的接收端）。

⚠️ 顺带发现、**没修**的一条（main 上就红，和 Webhook 无关）：SQL Server 上**刚灌完种子**的 `fba_test`，
`test_open_api.py::TestIncrementalSync::test_inserts_and_soft_deletes_show_up_after_the_cursor` 必红 —— 种子时间是
`GETDATE()` 的 `.6466667`（第 7 位非 0），测试拿接口返回的、已经舍入到微秒的时间自己拼游标，游标落在种子之前，
种子部门全被当成「之后的变更」返回。服务端查询那一侧早已 CAST 过（上面「增量同步的静默坑」），坏的是测试拼游标的方式。
