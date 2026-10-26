# plugin/notification —— 站内收件箱 + 通知渠道路由

> 扩展级插件（`[app] extend = "admin"`），接口在 `/api/v1/sys/notifications/*`（收件箱）和
> `/api/v1/sys/notification-channels/*`（渠道路由，#166）。收件箱的前端那一半见
> [`pages/notification` 分册](../../../../../packages/platform/src/pages/notification/AGENTS.md)。
>
> 这份文件是 [`apps/api` 分册](../../../AGENTS.md) 的**子分册**，Claude Code 读到本目录下的
> 文件时才把它加载进上下文（惰性加载）。跨模块的硬纪律只在根 `CLAUDE.md` 里有一份；
> **新增结论请追加到离代码最近的那一份**。

## 三层（#166）

```
使用方      notification_service.create_in_tx(db, kind=…, user_ids=…, …)   ← 唯一写通知的入口
路由层      kinds.py 注册表 · 系统策略（sys_notification_policy）× 个人偏好（sys_notification_pref）× 有没有地址
投递层      sys_notification_delivery（事务内 outbox）· Celery `notification.deliver_pending` 每 15 秒 + 提交后踢一脚
渠道层      senders.py：email（邮件插件 send_email）· sms（短信插件 sms_service.send）—— 永远返回分类结果、永远不抛
```

- **类型（kind）由使用方声明**：各插件放 `notification_kinds.py`（审批流 `plugin/workflow/`、公告 `plugin/notice/`），
  `extensions.py` 扫描；平台核心（导出、每日问候）的类型在 `kinds.py: load_builtin_kinds`
- 策略 / 偏好都是「有行 = 覆盖、没行 = 注册表默认值」；策略改回默认值就删那一行
- 站内一律 `forced`；全员广播的类型只许站内（广播在站内是一行、不 fan-out，外部渠道等于全员群发）

## 🔴 投递行和站内行在调用方的事务里写

`create_in_tx` 不 commit、不推送，返回 `Dispatch`，提交之后调用方 `after_commit()`（推 socket + 踢 worker）。
审批流把这两件挂进 `_Ctx.effects`。这样业务回滚时投递行一起没了，不会「审批没成、邮件先到」。
守卫：`tests/test_channels.py::TestRouting::test_rollback_takes_the_delivery_rows_with_it`。

⚠️ `notification_service.send()`（管理端手动发）因此改成在 service 里自己 commit，路由从 `CurrentSessionTransaction`
换成了 `CurrentSession`：依赖收尾才提交的话，被踢醒的 worker 读不到投递行。

## 🔴 worker：抢占看 rowcount · 结果未知不重试 · 停在发送中的归「结果未知」

- **抢占**是一条 `UPDATE … SET status='sending' WHERE id=? AND status IN (待发, 到点的失败)`，只有 rowcount == 1 的那个 worker 发
- **结果未知**（短信插件的 `unknown`：连上之后出了事）不重试 —— 重试就是重复发；邮件那边连接 / 超时一律重试（重复一封邮件的代价小于漏一条催办）
- 停在 `sending` 超过 `NOTIFICATION_SENDING_STALE_SECONDS` 的行归 `unknown`，**不改回 pending**（它已经交给渠道了）
- 重试状态在表里（`next_attempt_time`），不用 `apply_async(countdown=…)`：扫表幂等，worker 重启不丢
- 🔴 **注册表要在 worker 里也装**（同短信插件那条）：`kinds.require_notification_kind()` 每次调 `load_notification_extensions()`

## 写测试时踩的

- 🔴 **日志清理任务里不要调 `load_notification_config`**（它经 `config_service.get_all` 走 Redis 缓存）。
  `test_prune_logs.py` 在 `asyncio.run()` 开的一次性循环里跑清理任务，共享的 `redis_client` 连接池被绑到那个随即关掉的循环上，
  **下一个文件**里第一条走 TestClient 的用例在 setup 就 `Event loop is closed`。红的是 `test_result_columns.py`，
  和通知毫无关系，单独跑还是绿的。保留天数改成 `service/config.py: delivery_retention_days` 直接查 `sys_config`。
  **实测证据**：PR #169 第一次 CI，PostgreSQL / SQL Server 两个 pytest job 都只红这一条；改完本地 `app/task/tests` 189 条全过

- 🔴 **两遍完整的 `deliver_pending()` 并发，验不出抢占。** 第一版并发测试是 `gather(deliver_pending(), deliver_pending())`，
  把抢占条件删掉（变异）**照样绿**：在同一个事件循环里，两遍几乎不会在「取一批」和「抢占」之间交错 —— 后一遍取批时
  前一遍已经把那行改成 `sending` 了。改成两个 `_deliver_one(pk)` 直接抢同一行之后，同一个变异当场红
- **worker 每轮从参数配置重读重试次数**（`load_notification_config`），测试里 monkeypatch `settings.NOTIFICATION_RETRY_MAX`
  会被库里的值（4）覆盖回去 —— 要连加载函数一起顶掉
- 异步代码经 `client.portal.call` 跑（`async_db_session` 被 conftest 换成了绑在 TestClient 循环上的测试库会话）；
  `delivery_service` / `senders` 登记在 `conftest._PATCHED_SESSION_MODULES`
- 审批流的并发 / 超时测试 monkeypatch 的是 `runtime_service.notification_new`：改审批流的通知时这个模块级名字要留着

## 实测证据

`tests/test_channels.py` 41 条 + `plugin/workflow/tests/test_notification_channels.py` 3 条，真实测试库 + 真实 Redis，
PostgreSQL 和 SQL Server 都过（2026-10-26，本机）。MySQL 没跑。
变异各打红一条：抢占不看状态 · 结果未知当失败重试 · 个人偏好收下 forced 的格子 · 缺地址静默跳过 · 审批事务出口不发「新的待办」。
迁移 `ab000000notifych` 在两个方言的 `fba_test` 上 `downgrade -1` → 三张表 / 7 条菜单 / 4 行参数 / 1 行调度全部消失 →
`upgrade head` → 全部回来、SQL Server 上 `sys.identity_columns` 里这三张表 0 行（雪花主键没被建成 IDENTITY）→
`test_model_matches_migrations` 绿。
E2E `apps/web/e2e/tests/notify-channels.spec.ts` 2 条；变异（个人中心不看 `configurable`）→ 锁那一条红。
邮件 / 短信渠道**没有真发过**：发送层在测试里是假的，分类规则（SMTP 5xx 永久、4xx 重试）来自 aiosmtplib 的异常层级，不是真服务器的回包。
