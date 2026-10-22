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

## 🔴 增量同步的两个静默漏数据点

- 变更时间用 `COALESCE(updated_time, created_time)`：`DateTimeMixin.updated_time` 可空，新插入的行是 NULL，
  只按它查会**漏掉所有新增**
- 软删的行也要返回（`deleted: true`），所以 `service/sync_service.py` **直接写 select、不走 DAO**
  （DAO 的查询都带着 `deleted = 0`）
- 游标比较展开成 `t > :t OR (t = :t AND id > :id)`，不写行值比较 —— SQL Server 不支持

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
- **迁移 `k0000000openapp` 和 PR #119 的 `k0000000wfaireview` 都从 `j0000000aimcpwrite` 分出**：后合并的那个要补一条
  merge revision，否则 `test_single_head` 红

**实测证据**：独立库 `fba_open_scratch`（PostgreSQL）上 up → 与模型比对零差异 → down（两张表和 8 条菜单都消失）→ up。
SQL Server / MySQL 只过了离线编译守卫（`test_migrations_compile_offline_for_every_supported_dialect`），没在真库上跑。

## nginx 不能改写 `/api/` 的路径

签名里的 PATH 是请求行里的原样路径。现在 `apps/web/nginx.conf` 的 `proxy_pass http://api:8000;` 不带 URI，
路径原样透传；**谁给它加上 URI 或 rewrite，所有开放接口的签名都会对不上**，报的是一句看不出原因的「签名不匹配」。

## 🔴 SQL Server 上增量同步的游标会原地打转（亚微秒精度）

症状：CI 的 `pytest · SQL Server` 间歇性地停在 59% 不动，20 分钟后 job 被取消，日志里**没有任何报错**。
对接方那边的表现一样：同步程序拿到 `has_more: true`，一页一页翻，每一页都是同样几行、同一个 `next_cursor`，永不结束。
PostgreSQL / MySQL 从不出现。

根因：SQL Server 的 `datetimeoffset(7)` 存到 100 纳秒，Python 的 `datetime` 只到微秒，pyodbc 读出来时**截掉**第 7 位。
游标里带回去的是截短的值，于是 `changed > :t` 对已经返回过的那一行永远成立。种子数据用 `GETDATE()` 写时间，
它只精确到 1/300 秒，毫秒尾数是 3、7 时会带上第 7 位（`.6566667`），尾数是 0 时正好整微秒 —— 所以是间歇的。

修法：`service/sync_service.py` 的 `_ToMicrosecond` 先把变更时间截到微秒，排序、比较、编游标都用截过的值。
它按方言编译，SQL Server 上是 `DATEADD(nanosecond, -(DATEPART(nanosecond, x) % 1000), x)`，其余方言原样输出。
**不能用 `CAST(x AS datetimeoffset(6))`**：那是四舍五入，和 pyodbc 的截断对不上，照样打转。

测试侧：`tests/test_open_api.py` 的 `_drain` 原来是 `while True`，游标不前进时测试不失败、只是挂住。
现在有 `MAX_PAGES` 上限，并且同一个 `next_cursor` 出现两次就当场失败。
`test_sub_microsecond_times_still_page_through` 直接写入带第 7 位的时间，不靠种子的运气（只在 SQL Server 上跑）。

实测：
- 本地临时 SQL Server（与 CI 同一个 digest）上，种子时间是 `02:43:59.6566667Z`，游标里是 `.656666`，
  同一个 `next_cursor` 连续返回；2 核和 16 核都复现，和 CPU 无关
- 同一个值：`CAST(… AS datetimeoffset(6))` 得到 `.656667`，`DATEADD` 截断得到 `.656666`
- 撤掉修复后，两条同步测试都在第二页报「游标原地打转」，不再挂住
- CI 上 storage 分支到 main、再到 #125，6 次运行里有 4 次停在 59%
