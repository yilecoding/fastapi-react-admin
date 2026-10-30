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
渠道层      senders.py：email（邮件插件 send_email）· sms（短信插件 sms_service.send）· bot（群机器人，二期）—— 永远返回分类结果、永远不抛
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

🔴 **广播（`broadcast()`）的 socket 推送也挂在提交之后**（`push_broadcast_after_commit`，走公用的 `common/after_commit.py: run_after_commit`，
`kick_after_commit` 也改成了它；回滚不做，同一个事务里多次只做一次）。
#186 之前是写完那一行当场推：公告接口的提交在依赖收尾，铃铛收到推送立刻重拉未读数，读到的是提交前的旧数 —— 上面那条规矩唯独广播这条路漏了。
**实测证据**：`app/admin/tests/api_v1/test_notice_reach.py::test_broadcast_pushes_only_after_commit`（回滚后同一个会话再提交：不推；提交：推一次）；
变异改回当场推 → 红。

## 收件箱行的来源：`sys_notification.source`（#186）

`<类型>:<ID>`（`sources.make_source`），给要反查 / 撤回自己那一行的调用方用（现在只有公告：`notice:<id>`）。`link` 是给前端跳转的自由字符串，不拿来反查。
列表接口按来源回填 `attachment_count`：通知插件不认识公告（依赖方向是 notice → notification），由来源方 `register_source_attachments` 登记计数函数。
撤回 = 逻辑删除那一行 + 清已读标记（`crud_notification.retract_by_source`）；列表 / 未读数 / 详情本来就都带 `deleted == 0`。
细节和实测证据见 [`plugin/notice` 分册](../notice/AGENTS.md)。

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

## 🔴 短信只发本人验证过的号

`sys_user.phone_verified_time` 为空 = 管理员录入 / 导入的号（#168）。手机登录早就只认验证过的号，短信通知原来没跟上：
号码打错一位，审批标题就发到陌生人手机上，而投递记录里显示「已发出」。现在 `routing.resolve` 对这种号记一行
`skipped / phone_unverified`（不退回 `no_address`：「有号没验证」和「没号」要分得开），个人中心的通知偏好在短信那一列标「手机号未验证」。

**实测证据**：`tests/test_channels.py::TestRouting::test_sms_needs_a_phone_the_owner_verified` —— 同一个号，没验证时 skipped、
验证后 pending。变异：去掉那个判断 → 红。

## 群机器人（#166 二期）

> 接入步骤（建飞书机器人 → 登记 → 发测试消息 → 报错对照）和两道设计练习在 [`docs/guides/notify-bot.md`](../../../../../docs/guides/notify-bot.md)。

```
bot_platforms.py   三家的协议：地址前缀 · 签名 · 消息体 · 回包分类（纯函数，不认识 backend.* / httpx）
bot_service.py     配置的增删改查（地址 / 密钥加密）· 发测试消息 · enqueue_bots（事务内写投递行）
senders.post_bot   发一次 HTTP；投递 worker 和「发测试消息」共用
```

- **不按人路由**：类型声明 `bot=True`（「这条通知的文案对一个群说得通」）才能被机器人订阅；订阅关系在机器人自己身上
  （`sys_notification_bot.kinds`），不进策略 / 偏好矩阵，`defaults` 里写 `bot` 当场抛。现在开了的：公告 · 审批结果 · Webhook 端点停用。
  🔴 对着收件人说话的不开（「抄送给你」「新的待办」「X 退回了你的申请」）—— 为此「被退回」从 `workflow.result` 拆成了 `workflow.sent_back`
- **一条通知 × 一个机器人一行**，和收件人有几个无关（投递行 `user_id` 为空、`bot_id` 有值、`address` 是机器人名称快照）
- 广播（公告）的提交在调用方手里（依赖收尾），所以 `broadcast()` 用 `kick_after_commit`（会话 `after_commit` 监听）踢 worker；回滚清掉标记
- 🔴 **Webhook 地址本身就是凭据**：和加签密钥一起用 `NOTIFICATION_ENCRYPT_SECRET_KEY` 加密存，没配就拒绝保存；
  接口只给 `webhook_hint`；入参字段 `webhook_url` / `sign_secret` 在 `OPERA_LOG_REDACT_KEYS` 里
- 🔴 **地址只许落在三家官方前缀上**（协议 + 主机 + 端口逐项比、路径按前缀、带 userinfo 的拒），私有化部署配
  `NOTIFICATION_BOT_EXTRA_URL_PREFIXES`（prod 只许 https）。不跟随重定向
- 🔴 **读超时 / 对方断开 = 结果未知、不重试**（可能已经进群了，群里出现两次比重复一封邮件显眼得多）；连接没建立才重试。
  2xx 但读不出业务码同样按结果未知
- 🔴 **发之前自己数频率**（`RATE_LIMITS`：钉钉 / 企微 20 条/分钟，飞书 100/分钟 + 5/秒）：这一分钟发够了就推到下一分钟，
  `reason=throttled`、**不算一次尝试**。不数的话一次批量审批让第 21 条起全被平台拒，每条白耗一次重试
- 消息一律纯文本类（飞书 `post` 的 text / a 标签，钉钉 / 企微 `text`），不用 markdown：标题正文是用户填的，
  走 markdown 就能塞一个看着像系统发的钓鱼链接。企微 text 上限 2048 **字节**，按字节截

**协议来源**：飞书（签名、错误码 9499 / 11232 / 19021 / 19022 / 19024、限频、20 KB）和企微（地址、20 条/分钟、2048 字节）是官方文档原文；
钉钉官方页面是前端渲染、抓不到原文，签名按多处转载的官方示例代码，310000 / 130101 两个码来自转载。企微的 45009 / 93000 官方页面上没有，是常见回包。

**实测证据**：`tests/test_bots.py` 66 条（假平台是 `httpx.MockTransport`）。变异各打红：飞书签名的密钥和消息对调 · 不比主机 ·
放过 userinfo · 按收件人展开 · 停用的机器人也发 · 读超时当重试 · 不限流 · 限流算一次尝试 · 企微按字符截 · 广播不写机器人 ·
企微收密钥 · 钉钉时间戳用秒。⚠️ 「回滚也踢」第一版**没打红**：测试在一个会话里回滚、另一个会话里提交，标记跟着会话一起丢了；
改成同一个会话回滚后再提交才红。
E2E `apps/web/e2e/tests/notify-bot.spec.ts`：界面新增 → 测试消息打到假飞书、按官方算法验签通过 → 平台回 19024 时原因留在卡片上 →
发公告后投递记录里有这个群的一行。变异：签名对调 → 验签那句红。
迁移 `ae000000notifybot` 在 PostgreSQL（开发库）和 SQL Server（`fba_test`）上 `upgrade → downgrade -1 → upgrade` 都过，
SQL Server 上新表不是 IDENTITY；autogenerate 和迁移后的库比对没有本次的差异。
**真飞书（2026-10-30，开了签名校验的自定义机器人）**：加签的测试消息 200 + `code 0`、465 ms，进群；
发布公告 → worker 投递 → `sent`、第 1 次就成（两条，3845 ms / 441 ms）；错密钥和不带签名都回
`19021 sign match fail or timestamp is not within one hour from current time`，分类成 `sign_failed` / 不重试。
**钉钉、企业微信还没在真群上发过**：签名和回包分类靠文档 + 假服务器。

🔴 **httpx 的 INFO 日志会把 Webhook 地址整条写进 `fba_access.log`**（`HTTP Request: POST <完整 URL>`，经 `InterceptHandler` 进 loguru）。
症状是没有症状：消息照发，凭据静静落盘。上面那次真飞书测试就是这样发现的，token 原样在日志里。
修法：`common/log.py` **模块顶层**把 `httpx` logger 提到 WARNING。
⚠️ 第一版放在 `setup_logging()` 里，只修了 API 进程：worker 不走 `setup_logging`（`celery -l info` 自己接管根 logger），
而往群里发消息的正是 worker。API 进程里的测试是绿的，真公告走 worker 时日志里照样是 `[INFO/MainProcess] HTTP Request: POST …/<token>`。
**实测证据**：
- `test_bots.py::TestApi::test_webhook_url_never_reaches_the_log`（API 进程），去掉那一行就红
- `test_bots.py::TestApi::test_worker_does_not_log_the_webhook_url_either`（子进程里 import worker 入口、按 `-l info` 配根 logger），
  修复放在 `setup_logging` 里时红在 `INFO:httpx:… /hook/0123456789abcdef-pytest`
- 真飞书公告走 dev worker（2026-10-30）：修之前 worker 日志带整条地址；挪到模块顶层并重启 worker 后，同样一条公告 441 ms 送达，日志里 token 0 次

### 合并后补的评审（v0.9.0 发版后，2026-10-30）

#184 合并前没有评审；补的那一轮找出下面几条，都是**静默**的，测试先红后绿：

| 症状 | 根因 | 修法 | 测试 |
|---|---|---|---|
| `…/hook/../../../im/v1/messages` 存得进去，实际请求打到前缀外面 | 前缀按原始路径 `startswith` 比，httpx 发之前才把点段归一 | 解码后有 `.` / `..` 段就拒（`%2e%2e` httpx 不归一但对方服务器会，一起拒） | `test_url_must_sit_on_an_official_prefix` 三个点段用例 |
| 钉钉机器人改成飞书、密钥框留空：之后每条都 19021、不重试 | 换平台只强制换地址，旧平台的密钥留着 | 换平台没填新密钥 = 没有密钥 | `test_platform_change_drops_the_old_platforms_secret` |
| 消息进了群，投递记录却是「结果未知」 | 卡片的「最近成功」和投递终态同一个事务，卡片那步一失败就一起回滚，停在 sending | 终态先单独提交，卡片另起事务、失败只记 warning | `test_bot_card_update_failing_does_not_undo_the_send` |
| 一条没发，也不会再发 | 限流计数在抢到行之后、`try` 外面，查库一抛就冲出 `deliver_pending`，这一行停在 sending | 数不出来就照发（超了平台会拒，按重试走） | `test_throttle_check_failing_still_sends` |
| 轮换加密密钥后点「发测试消息」只有一个 500 | `send_test` 的解密没兜，worker 那边同样情况是 `config_error` | 同样回 `config_error` | `test_send_test_with_an_undecryptable_url_says_config_error` |
| 对接方端点的 token 被推进飞书 / 钉钉群 | `open.webhook.disabled` 开了 `bot=True`，正文里是完整端点地址 | 正文只留协议 + 主机 + 端口 + 路径 | `open/tests/test_webhooks.py::test_disabled_notice_does_not_carry_the_endpoint_credentials` |
| 不再可订阅的类型，编辑表单里看不见也去不掉，保存一直 400 | 表单只渲染 `bot=True` 的选项，回填的值里却有别的 | 列出来、标「已不能订阅」，取消勾选就能存 | 无前端单测；`pnpm typecheck` |
| 英文界面上群机器人卡片写着 "Approver added" | 「已加签」和审批流的「加签」（加审批人）共用一个 key | 改成「已开 / 未开签名校验」 | `notify-bot.spec.ts` |
