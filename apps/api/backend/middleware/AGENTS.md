# backend/middleware —— 中间件

> 这份文件是 [`apps/api/AGENTS.md`](../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的文件时才加载。
> 跨模块的硬纪律仍然只在根 `CLAUDE.md` 里有一份。

## 🔴 操作日志的响应体此前完全不脱敏

`desensitization()` 只作用于**请求**的 query/path/json/form，而且**只看顶层 key**
（嵌一层的 `password` 一个字符都不打码）；响应体只被截断，原样落进
`sys_opera_log.response_body`。两个洞都是静默的 —— 日志照常写、字段照常在。

现在 `desensitization()` 递归遍历 dict/list，且 `redact_body()` 对 JSON 响应先脱敏
再截断。三条要记住的：

- **顺序是「先脱敏后截断」**。反了等于没脱敏：截断后的片段不是合法 JSON，解析不了
- **解析失败一律不记原文，记一句占位**（fail-closed）。结构读不出来就没法确认里面
  没有敏感字段，宁可少一条日志，也不要记一条**看起来正常、实际没打码**的
- `text/plain` 不在此列 —— 纯文本没有可按字段打码的结构，保持原样截断

⚠️ **给 `check_production_settings` 加检查时要同步 `test_prod_config.py` 的
`_FakeSettings`**（它是最小配置对象，不是真的 `Settings`）。漏了会 `AttributeError`
把那个文件里所有用例一起打红 —— 吵闹但不静默，照着补上那一行即可。

## 🔴 重建响应时头要原样搬，不能 `dict(response.headers)`

`capture_response_body` 读完 JSON 响应体之后要重建一个 Response（`body_iterator` 只能消费一次）。
原来写的是 `headers=dict(response.headers)` —— `dict` 把**同名的头压成一个**（只留第一个），
一个响应里的第二行 `Set-Cookie` 就静默没了，接口返回 200、界面一切正常。

撞上它的是 #138：登录 / 刷新的响应里有两行 refresh cookie（真正下发的那个 + 清掉旧 `Path=/` 的那个），
第二行被吞，浏览器里的旧 cookie 留着，刷新时它盖过新的那个 —— 用户每 30 分钟被登出一次
（为什么旧的会赢见 [`common/security` 分册](../common/security/AGENTS.md)「refresh cookie 换了 Path」）。

现在搬 `raw_headers`（去掉旧的 `content-length`、按重建后的 body 重算）。

**实测证据**：`test_session.py::test_refresh_cookie_attributes` 第一次跑红在 `assert 1 == 2`，
真实响应头里只有一行 `set-cookie`；同一个最小 FastAPI 应用（不过这个中间件）返回的是两行。
变异检验：把 `raw_headers` 改回从 `dict(response.headers)` 构造，这条当场红。


## 🔴 客户端半路走了：`ClientDisconnect` 按 499 收掉，不是 500

浏览器跳页 / 关标签页会取消在途的 POST。请求体还没传完时读它，Starlette 抛 `ClientDisconnect`；原来没人接，
每次都记一条 ERROR + 几百行的栈、按 500 处理 —— 而客户端早就不在了，什么都收不到。日志里一片「请求异常」，
真正的错误被淹在里面。现在 `dispatch` 读请求参数和调路由时都接这个异常，回 499（nginx 的 client closed request），
记一行 INFO，不写操作日志（请求根本没执行）。

**实测证据**：本地真跑（2026-10-24）时 api 日志里撞到一次 `Exception in ASGI application … ClientDisconnect()`，
时间点紧挨着 Playwright 登录之后的跳页（是哪个请求日志里看不出来 —— 那条错误只带了 request id，没有路径，这是推断）；
`tests/test_opera_log_redaction.py::test_a_client_that_left_before_the_body_arrived_is_not_a_server_error`
构造一个 `receive()` 直接返回 `http.disconnect` 的请求，修之前当场抛 `ClientDisconnect`。

🔴 **第二个接法（路由跑到一半客户端走了）第一版写错了**：那个 `return` 在 `try` 里，`finally` 照样跑，按默认值
（`code=200` / `Success`）往操作日志里记了一条 —— 一个没执行完的请求在审计里成了「成功」。第一版测试只断言了 499，
没断言「没写日志」，所以是代码审查翻出来的。现在 except 里先把 `code` 改成 499、关掉 `should_log_opera` 再返回：
访问日志那一行照常记（显示 499），操作日志不写。
`test_a_client_that_left_while_the_route_ran_is_not_logged_as_a_success` 在旧代码上红：队列里是一条 `code='200' msg='Success'`。

## 🔴 请求体声明是 JSON、实际不是：原来是 500，不是 422

**症状**：任何接口收到一份截断 / 写坏的 JSON（`Content-Type: application/json`），回的是 **500**，
日志里是一条服务端异常 —— 看着像后端坏了，其实是客户端发错了；路由层本该回的
`422 json_invalid` 永远轮不到。

**根因**：这个中间件在路由**之前**读请求体（`get_request_args`），`request.json()` 抛 `JSONDecodeError`，没人接。
**修法**：接住 `ValueError`，交给路由层去拒；操作日志里只记一个占位（`_invalid_json` + 原始字节数）。

🔴 **不能记原文。** 第一版接住之后「照原文记进 `data`」—— 解析不了就没法按字段脱敏，一份截断的
`PUT /me/password` 会把新旧两个密码**明文**写进 `sys_opera_log`（改邮箱、建用户同理）。和上面响应体那条是同一个
fail-closed 判据，自己写的时候却漏了，是代码评审翻出来的。实测（变异：改回记原文）：
`test_a_broken_json_body_with_a_password_is_not_logged_in_plain_text` 红在
`旧密码明文进了操作日志：{"data": "{\"old_password\": \"Old-Secret-1\", …`。

**实测证据**（#202，个人偏好「非法 JSON 被拒」那条）：`PUT /sys/users/me/preferences/pytest.layout` 带
`{"value": {"cards": [` —— 修之前测试红在 `JSONDecodeError`，栈顶是 `opera_log_middleware.py: get_request_args`；
修之后 422。真起一个 uvicorn 用 curl 发同一份：不带修复 **500**、带修复 **422**。回归两条：`tests/test_opera_log_redaction.py::test_a_body_that_claims_json_but_is_not_does_not_blow_up_before_the_route`（中间件单测）+
`app/admin/tests/api_v1/test_user_preference.py` 的「截断」参数。变异（`except ValueError` 改成别的异常）→ 两条都红。

## 🔴 操作日志漏打码的凭据：参数配置的 `value` · 列表请求体 · 名单里没有的字段名

**症状**：保存参数配置、打开参数配置页之后去看操作日志，请求参数和响应体里 `EMAIL_PASSWORD` 那一行的值是明文。
前端参数配置页把它藏起来了，数据变更审计也只记「改过」，唯独操作日志留着 —— 有操作日志查看权限的人都看得到，而且一直留在表里。

同一轮排查出来的另外几处（**本机开发库实测 109 条 `/auth/login` 的操作日志明文留着 `access_token`**）：
登录 / 刷新 / 二次验证响应里的访问令牌、模型密钥的请求体字段 `api_key`、导入提交的 `import_token`、AI 二次确认的 `token`。

**根因**三个，都是静默的：
- 打码按**字段名**（`OPERA_LOG_REDACT_KEYS`）。参数配置的一行是 `{"key": "EMAIL_PASSWORD", "value": "…"}`，
  要打码的字段就叫 `value`，名单里永远不会有它（也不能有：`value` 是到处都在用的普通字段名）
- **列表请求体根本不过脱敏**：`get_request_args` 只给 dict 走 `desensitization`，列表被 `str()` 成一段 Python repr 记进 `data`。
  批量保存参数配置的请求体正好是列表
- 名单是**按字段名一个个加的**：新接口用了个新名字（`api_key`、`access_token`）就没人想起来加

**修法**：
- `desensitization` 认 key / value 形状：一个 dict 里有 `value`、同一层的 `key` 像密钥，就打掉 `value`。
  「像密钥」的规则在 `common/secret_keys.py`，**和前端参数配置页打码、数据变更审计共用一条**（后缀匹配、不分大小写）。
  原来后端那份区分大小写、没有 CREDENTIALS，和前端对不上 —— 现在 `tests/test_secret_keys.py` 读前端那行正则对账
- 任何 JSON 请求体都记进 `json`、都过脱敏（前端详情把 `args` 整个当 JSON 显示，形状变了不受影响）
- 名单补上 `access_token` · `refresh_token` · `api_key` · `import_token` · `token`；**守卫** `test_every_credential_like_field_in_the_api_is_redacted`
  扫全部请求 / 响应 schema，字段名像凭据（password / secret / token / api_key / credential）又不在名单里就红 ——
  要么进名单，要么在测试里的 `_NOT_CREDENTIALS` 写一句为什么不是（用量计数、掩码、过期时间…）
- 已经写进去的行由迁移 `aq000000operalogsecret` 清（`app/admin/utils/opera_log_scrub.py`）：只扫会写出这些东西的接口
  （`/configs` · `/auth/` · `/ai/` · `/import/`）；读得回结构的照新规则打码，repr 读回结构后按新写法放进 `json`；
  响应被截断、读不回结构又有凭据的，整段换成一句占位（同上面的 fail-closed）

### 评审补的（#283）

| 症状 | 根因 | 修法 | 测试 |
|---|---|---|---|
| 迁移清完了，打开「操作日志」页那次请求的日志里还躺着别人的密钥 | 它的响应体是一页别人的日志：`args` 嵌在 JSON 里，响应体是**转义过的字符串**，`desensitization` 递归不进字符串、正则也认不出转义的引号 | 清理扫 `/logs/opera`，这种行的响应体整段换占位 | `test_opera_log_scrub.py` 的 `opera-view` 行 |
| 生产库上迁移长时间锁着日志表 | 全部改写在迁移那一个事务里，登录 / 刷新的日志一个活跃用户半小时一条 | `autocommit_block()` 里跑，逐行提交；每行幂等，断了重跑接着清 | PostgreSQL / SQL Server 私有库上 alembic 真跑 |
| 重跑迁移把新中间件写下的截断响应整段换掉 | 截断文本里键名像密钥就算泄漏，没看 value 是不是已经 `[REDACTED]` | 只看同一个对象里的 value | `cut-redacted` 对照行 |
| `merge-patch+json`、`text/plain` 发的 JSON 原样进日志 | 只认 `application/json`，其余当文本记（FastAPI 自己认 `*+json`） | `*+json` 和 `application/json` 同一支；别的类型先试着按 JSON 读，读得出就打码 | `test_a_json_body_under_another_content_type_is_still_redacted` 等三条 |
| 管理员自己加的 `OSS_SECRET_KEY` / `SMTP_PASS` / `REDIS_PWD` 前端不打码、日志和审计照记 | 规则只认 PASSWORD / SECRET / TOKEN / API_KEY / CREDENTIALS 结尾 | 补 `SECRET_KEY` · `PRIVATE_KEY` · `PASS` · `PWD` · `AUTH_CODE`（`PASS` / `PWD` 前面要是下划线或开头，`LOGIN_BYPASS` 不算） | `test_secret_keys.py` |

**没改的**（风险低，写清楚）：部署时旧进程在迁移扫完之后还写进来的那几十秒（日志队列最长 60 秒一批）扫不到；
AI 确认令牌、导入报告令牌出现在 URL 路径里（`path` 列不打码），两个令牌都校验归属、一次性 / 短时效。

⚠️ 升级之后**建议把 SMTP 授权码、模型的 API Key 换掉**：迁移清得掉表里的，清不掉已经导出、备份、被人看过的。访问令牌会自己过期，不用管

**实测证据**：
- `tests/test_opera_log_redaction.py` 新增三条：键名判断、列表请求体、响应体。修之前三条都红，请求体那条红在
  `{"data": "[{'id': 1, … 'value': 'smtp-auth-code' …}]"}`
- `plugin/config/tests/test_opera_log_secret.py` 走真接口截住入队的那一条：新建、编辑、批量保存、两种列表读法，共 7 条日志。
  对照组是普通参数的值，必须照记
- `tests/test_opera_log_redaction.py` 再加三条：登录响应的令牌、`api_key`、扫 schema 的守卫。守卫第一次跑就扫出
  `access_token` · `api_key` · `import_token` · `token` 四个漏网的
- `app/admin/tests/test_opera_log_scrub.py` 在真库里垫修复前的七种形状（参数配置的 JSON · repr · 完整响应 · 截断响应 ·
  登录响应的令牌 · 截断的登录响应 · 模型密钥），外加两行对照（截断但没有密钥的 · 别的接口）；跑两遍，第二遍不变
- 迁移在私有库（PostgreSQL 16）上用 alembic 真跑：插一行泄漏的旧日志 → `upgrade head` 报「1 行已打码」、读回来两处都是 `[REDACTED]` → `downgrade -1` → 再 `upgrade` 报「0 行」
- 变异 15 处各有测试红（含评审补的 5 处：只认 `application/json` · 别的类型不试着解析 · 不扫操作日志页 · 截断文本不看 value · 规则退回旧的）：不认 key/value 形状 · 列表照旧 `str()` · `value` 一律打掉（对照组红）· 规则区分大小写 ·
  清理不管 repr · 截断的照留 · 名单去掉 `access_token` · 去掉 `api_key` · 清理不认名单里的字段 · 清理不扫 `/auth/`
