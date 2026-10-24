# plugin/sms —— 短信（SDK + 配置 + 发送 + 日志）

> 应用级插件（`[app] router = ["v1"]`），接口在 `/api/v1/sms/*`。设计、调研、否掉的方案见 issue #153。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 两层

```
使用方                await sms_service.send(phone, template, params)        ← 只有这一个函数
插件层  plugin/sms    配置表 + 配置页 · 选配置 · 频率防护 · 两段式日志 + 日志页
SDK 层  plugin/sms/sdk  SmsProvider 基类 · 厂商注册表 · 统一的结果和错误分类 · 阿里云 / 腾讯云 / 控制台
```

🔴 **SDK 层不认识 `backend.*` / sqlalchemy / redis / fastapi**（`tests/test_sms_guards.py::TestSdkPurity` 按 AST 扫）。
它要能在脚本 / 别的项目里单独用，也要能脱离插件做契约测试。接第三方：下游插件里放一个模块
`backend.plugin.<插件>.sms_providers`（继承 `SmsProvider` + `@register_provider`），业务模板放
`backend.plugin.<插件>.sms_templates`（`register_sms_template`），`extensions.py` 启动时扫描 ——
和 AI 插件发现各插件的 `ai_tools` 模块同一个机制，不改短信插件源码。

## 🔴 两家官方 SDK 的四条硬约束（都是实测，`tests/test_sms_sdk.py` 用真 SDK 打本地假服务器）

| 约束 | 不守的表现 |
|---|---|
| **成败读业务码，不看「有没有抛异常」** | 两家的单号码失败都是 HTTP 200 正常返回；腾讯云响应头带 `charset` 时**连接口级错误都被吞成 `SendStatusSet=None`** —— 当成功处理就是把一次鉴权失败记成「已受理」。`SendStatusSet` 为空一律「结果未知」 |
| **「没连上」和「读超时」要分开** | 只有「连接没建立」算未发出（`network_unsent`，冷却位释放）；连上之后的任何异常都是「结果未知」（冷却位保留）。反过来就是重复发 |
| **代理只走进程环境变量** | 腾讯云异步客户端一设 `HttpProfile.proxy` 就 `TypeError: ... 'proxies'`（SDK 还在用 httpx 0.28 删掉的参数）。守卫 `test_tencent_adapter_never_sets_http_proxy` |
| **凭据永远显式传** | 阿里云凭据库没给 AK 时走默认凭据链，ECS 角色凭据会起一个 apscheduler 后台线程。凭据为空的配置在**保存时**拦 |

⚠️ aiohttp 的 `ConnectionTimeoutError` 和 `SocketTimeoutError` **都是 `ServerTimeoutError` 的子类**：
`sdk/base.py` 按 MRO **名字**认，只认前者，绝不认父类。按父类判会把读超时误判成未发出。

⚠️ 错误码表里实际触发过的只有 `AuthFailure.SecretIdNotFound` / `InvalidAccessKeyId.NotFound` / `InvalidCredentials`
和阿里云的 `isv.SMS_TEMPLATE_ILLEGAL`（2026-10-24 真发时填错模板 ID → `config_error`，原文「请检查模板内容与模板参数是否匹配」），
其余是文档原文，实现按码前缀兜底（`LimitExceeded.PhoneNumber*` → `rate_limited`）。签名错、号码错还没造出来过。

## 🔴 发送日志：独立会话，两段式（`service/sms_service.py`）

初稿是「在请求会话里用 `begin_nested()` 包住日志，再抛 502」—— issue 评审时在一次性 PostgreSQL 库上实测
**失败日志会丢**：`begin_nested` 只防「日志写失败弄坏外层事务」，挡不住「外层回滚把日志一起带走」。
现在 `send()` 的读写全部 `async with async_db_session.begin()`：发送前插一行「发送中」并提交（插不进去就不发），
发完更新成终态（更新失败只 `log.error`）。所以

- 🔴 **`send()` 不参与调用方的事务**。调用方要在自己的写操作**提交之后**再发，否则「短信发了、业务回滚了」
- 🔴 模块顶层 import 了 `async_db_session`，**登记在 `backend/conftest.py: _PATCHED_SESSION_MODULES`**，否则跑测试往开发库写日志
- 🔴 **注册表不能只在 `api/router.py` 装**：Celery worker 不 import 任何路由，定时任务里调 `send()` 会报「业务模板未注册」/
  「厂商不存在」，而同一段代码在 uvicorn 里是好的。`SmsService._validate` 再调一次 `load_sms_extensions()`（幂等）。
  守卫：`test_sms_send.py::TestRegistryOutsideWeb`（清空两个注册表再发，必须成功）
- 进程在两步之间崩溃 → 那一行停在「发送中」；接口按 `SMS_SENDING_STALE_SECONDS` 标 `stale`，日志页显示成「结果未知」。**库里的行不改**

**实测证据**：`tests/test_sms_send.py` 用**另一个**引擎读 `sms_log`：失败 / 未知 / 成功三种结果的那一行都在，
被我们自己拦下的（冷却 / 日上限 / 熔断）**不写日志**。

## 🔴 频率防护：一段 Lua 占位，发送之前（`service/guard.py`）

冷却（`SET NX EX`）· 号码日上限 · 全站小时熔断三项检查和占位在同一段 Lua 里完成。「先查再发再写」是读写分离的，
并发能同时穿过（AI 确认令牌那条：修复前 5 个并发执行了 5 次）。号码日上限和全站计数**不退还**；
冷却位和**配置的日计数**只在 `UNSENT_KINDS` 时退还（`release_cooldown` / `release_config`）。

🔴 **配置的日计数要退还，判据和冷却位同一组。** 第一版写的是「日上限不退还」，真发阿里云那一轮当场对不上账：
填错模板 ID 发了一条（`isv.SMS_TEMPLATE_ILLEGAL`，厂商一条没收），改对再发一条，卡片上「今日已发 2」、手机收到 1 条。
而且填错的每次重试都在消耗这条配置的 `daily_max`。`release_config` 是一段 Lua：计数 > 0 才 `DECR`，键过期 / 跨天
/ 并发多退一次都停在 0。「结果未知」（读超时）不退 —— 可能已经发出去了。测试短信走同一条路。
守卫：`test_sms_send.py::TestConfigDailyRefund` · `test_sms_config_api.py::TestSendTest::test_rejected_test_sms_does_not_count_as_sent`。

**实测证据**：`TestGuard::test_concurrent_sends_let_exactly_one_through` —— 5 个并发同一号码，恰好 1 条通过、4 条 `rate_limited`、
库里 1 行。🔴 **先预热连接池**（`redis_client.ping()` 几次），冷池会假绿。

🔴 **释放冷却位是 compare-and-delete，不是裸 `DEL`。** 连接超时最长 = 配置的 `timeout`（上限 60 秒），和验证码的冷却一样长：
慢请求判定「没连上」时自己占的位早已过期、下一条已经重新占上，裸删等于删掉别人的冷却位，第三条就穿过去了。
`acquire` 把本次令牌写进冷却位，`release_cooldown` 只删值等于令牌的那一位（`TestGuard::test_release_only_deletes_own_cooldown_slot`）。

## 选配置（`pick_config` + `_choose`）

指定 `config_id` → 只用它（必须启用且配了这个模板）。否则候选 = 启用 ∧ 配了模板 ∧ 今天没到 `daily_max`：
默认在候选里 → 用它；否则按 `weight` 加权随机（0 不参与）；一个都没有 → `config_error`，**不静默跳过**。
每次**现查**不缓存（多副本下改了配置即刻生效）。`daily_max` 的计数在 Redis，选中后原子 `INCR`，超了退回换下一个。

## 配置页保存时的闸门（`service/config_service.py`）

写错的键名 / 模板码 / 参数名 / 缺凭据一律 400 —— 否则要到发送时才失败，看起来像通道坏了（MCP 凭据那轮踩过）。
`options` 里**不认识的键也 400**（pydantic 默认忽略 extra，这里自己比一遍）。凭据不能从 `options` 里绕进来（会明文落库）。

- `SMS_ENCRYPT_SECRET_KEY` 没配就拒绝保存带凭据的厂商，不静默存明文；独立于 `AI_ENCRYPT_SECRET_KEY`（两个插件可以单独装卸）
- 🔴 **编辑时换了厂商就必须给新密钥**（400 `credential_required`）。「留空 = 不改」只对同厂商成立：旧密钥是上一家的，
  形状校验照样过，存下来就是「厂商是腾讯云、密钥是阿里云的」—— 卡片上看着正常，每次发送都鉴权失败
- 厂商模板 ID 限 64 字符（`model/log.py: TEMPLATE_ID_MAX_LEN`，= `sms_log.template_id` 列宽）：保存配置和测试短信都在入口拦，
  否则到插「发送中」日志那一步才 `DataError` 500
- 🔴 入参字段名 `access_key_secret` 在 `OPERA_LOG_REDACT_KEYS` 里（精确匹配）；响应 schema 里既无明文也无密文，只有 `secret_mask`
- 🔴 `console` 厂商 `ENVIRONMENT == 'prod'` 时**不在注册表里**（`extensions.console_provider_allowed`）：库里留着一条也会报「厂商不存在」。
  不能只靠 `check_production_settings`，它看不到库里的行

⚠️ `registry.load_builtin_providers()` 不能只靠「import 即注册」：模块已经在 `sys.modules` 里时装饰器不会再跑，
摘掉 console 再装回来（测试里会）就悄悄少一家。现在按模块里的类显式再登记一次（幂等）。

## 写测试时踩的

- 🔴 **假厂商服务器和 SDK 客户端必须跑在同一个事件循环里。** 第一版 fixture 里 `asyncio.run(server.start())`、测试里再
  `asyncio.run(provider.send())`：监听 socket 绑在已关掉的循环上，连接能建立、请求永远读不到 —— 阿里云报
  「Timeout on reading data from socket」，看起来像 SDK 的读超时归类有问题。`run_with(server, body)` 一个循环里起停
- `aiohttp.web.AppRunner` 要 `shutdown_timeout` 很短：收尾会等挂着的 hang 处理器答完，把「读超时 1 秒」的测试拖成服务器的 sleep 时长
- 阿里云是 RPC 风格：参数在**查询串**里，表单体是空的 —— 断言请求内容看 `request.query`
- 测试短信接口按操作人限流，bucket key 是 `<前缀>:<策略摘要>:<sha256(标识符)>`，窗口活一分钟：测 429 前按摘要删掉上一轮的桶
- 控制台厂商的回显文案里号码也打码：那段文案进 `sms_log.provider_msg`，列表接口对号码是掩码的，文案里留着完整号等于掩码白做

## 实测证据

- `tests/` 119 条：SDK 契约 39（两家各一套行为矩阵 + 基类契约 + 模板映射）· 守卫 · 配置接口 · 发送链路（真 Redis + 测试库）· 日志接口
- 迁移 `z0000000sms` 在临时 PostgreSQL 库上 up → 与模型比对零差异 → down（两张表和 10 条菜单消失）→ up。SQL Server / MySQL 只过了离线编译守卫
- 阿里云 2026-10-24 用真凭据发过（签名 / 模板从 avcp 的种子拿的）：验证码模板一条「已受理」、手机收到；填错模板 ID 那条
  被归成 `config_error` 并进了日志。腾讯云**还没用真凭据发过**，代码靠契约测试里的假服务器
