---
title: 消息与通知
description: 实时推送的站内消息、带富文本 / 附件 / 发布范围的通知公告，以及按类型路由到邮件、短信和飞书 / 钉钉 / 企业微信群机器人。
sidebar:
  order: 7
---

fastapi-react-admin 的通知分三块：站内消息（顶栏铃铛 + 消息中心页，经 Socket.IO 实时更新）；管理员发给全员或指定部门 / 角色 / 人的通知公告；以及一层渠道路由 —— 按通知类型决定这条消息要不要再走邮件、短信，或推到飞书、钉钉、企业微信的群机器人。所有外部发送都先在调用方的数据库事务里写成投递行，再由 Celery worker 发出去，所以审批回滚了，邮件就不会先到。

## 在界面上哪里找？

| 入口 | 路径 | 权限码 | 做什么 |
|---|---|---|---|
| 顶栏铃铛 · **消息中心** | `/notification` | 登录即可 | 自己的站内消息、未读数、全部已读 |
| 工作台「公告」卡片 · 登录后弹窗 · 顶部横幅 | —— | 登录即可 | 读者侧的公告，谁看得见见[下文](#通知公告能带什么谁能看到) |
| **系统管理 → 通知公告** | `/plugins/notice` | `sys:notice:add` 打开；`edit` · `del` · `export` | 发布、编辑、删除公告，看阅读统计 |
| **消息推送 → 通知策略** | `/notify/policy` | `sys:notification:policy:list` · `edit` | 每种通知类型 × 每条渠道的系统策略 |
| **消息推送 → 投递记录** | `/notify/delivery` | `sys:notification:delivery:list` · `resend` | 每一次外部发送的结果，失败的可以重发 |
| 群机器人 | `/notify/bot` | `sys:notification:bot:list` · `add` · `edit` · `del` · `test` | 飞书 / 钉钉 / 企业微信群机器人的地址和加签密钥 |
| **短信 → 短信配置 / 发送日志** | `/sms/config` · `/sms/log` | `sms:config:list` · `add` · `edit` · `del` · `test`；`sms:log:list` · `del` | 短信厂商凭据与模板、每条短信的发送结果 |
| **个人中心 → 通知偏好** | `/profile` | 本人 | 每种通知要不要走邮件 / 短信；系统策略是「强制」的格子锁住 |

另有一个 `POST /api/v1/sys/notifications`（`sys:notification:send`）给管理员手动发站内通知。

## 站内消息怎么做到实时？

站内消息存在 `sys_notification`，分四类：系统、公告、任务（后台导出）、审批。写入一行后，服务端推一个 Socket.IO 事件 `notification:new`，**不带任何内容**；前端收到只是重新走 REST 拉列表和未读数。所以权限只在 REST 一处判。未读数在每次进页面时也走 REST 拉一次 —— 断线期间到达的通知照样能在红点上看到。未读数接口失败时，铃铛角标显示 `!`，而不是什么都不显示（那和「没有未读」长得一模一样）。

全员广播在库里只有一行，不按人展开；每个人的已读状态记在 `sys_notification_read`。账号创建**之前**写的广播对这个账号算已读，新同事第一次登录不会看到几十个历史红点 —— 「必须确认」的公告除外。

审批人收到新待办时**不**写站内消息，审批中心的待办角标靠另一个 socket 事件 `workflow:todo` 刷新（见[审批流](/features/approval-workflow/)）。

## 通知公告能带什么？谁能看到？

公告正文是富文本（Tiptap 编辑器），最多挂 20 个附件，另有这些开关：

| 设置 | 效果 |
|---|---|
| 类型 · 级别 | 通知 / 公告 · 普通 / 重要 / 紧急 |
| 置顶 | 排在前面；置顶 + 紧急 + 未读的公告还会以横幅出现（最多 3 条） |
| 过期时间 / 定时发布 | 过了 `expire_time` 就看不到；`publish_time` 之前谁都看不到。Celery 任务 `notice.sync_inbox` 每 60 秒跑一次，负责到点发出、过期撤回 |
| 弹窗 | 登录后弹出，读过才不再弹（最多 10 条，带正文） |
| 必须确认 | 读者要点「我已阅读」；「全部已读」会跳过这些行。必须同时开弹窗，否则 422 |
| 登录页可见 | 不登录也能看，每 IP 每分钟 30 次；最多返回 5 条，摘要是去掉标签后的 200 字纯文本 |
| 发布范围 | 部门（含所有下级部门）、角色（只认启用的）、用户。一行都没有 = 全员。「登录页可见」和发布范围同时设置会被 422 拒绝 |

「谁看得见」只有一份定义：[`crud_notice.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notice/crud/crud_notice.py) 里的 `readable_clause(viewer)` —— 没删、显示中、已到发布时间、没过期，并且看的人在发布范围里。读者列表、详情、弹窗、横幅、**附件下载权限**都用它，收件箱读的也是同一张受众表，所以不会出现「铃铛里有这条，点进去看不到、附件下不了」。隐藏、过期、未到发布时间、不在范围里的公告一律返回 404 —— 返回 403 等于告诉对方「这条存在」。有 `sys:notice:add` 的管理员能看阅读统计：发布范围里谁读了、谁没读。

附件和公告在同一个事务里提交，每个附件过三道校验：文件存在且不在回收站；发布人自己读得了（否则有发公告权限的人拿到别人私有文件的 ID，就能借公告公开给所有人）；不能是公开文件。

:::caution
正文里插的图片是公开文件（`/uploads/{key}`）—— `<img>` 标签带不上鉴权头。公告隐藏了、限定了范围，图片照样能访问。有保密要求的内容请放附件。
:::

## 一条通知怎么决定走邮件、短信还是群机器人？

每个插件在自己的 `notification_kinds.py` 里声明通知类型，通知插件启动时扫描。下面是 [`plugin/workflow/notification_kinds.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/workflow/notification_kinds.py) 里的原样代码：

```python
register_notification_kind(
    'workflow.remind',
    label='审批催办',
    category=NotificationCategory.WORKFLOW,
    defaults={'inapp': 'forced', 'email': 'default_on', 'sms': 'default_off'},
    sms_template='workflow_remind',
    sms_params=lambda title, content: {'title': title[:_SMS_TITLE_MAX]},
)
```

[`service/routing.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notification/service/routing.py) 对每个收件人 × 每条外部渠道看三样东西：管理员的**系统策略**（`off` / `default_on` / `default_off` / `forced`，在 **消息推送 → 通知策略** 里改）、本人的**个人偏好**（**个人中心 → 通知偏好**，`forced` 的格子是锁住的）、这个人**有没有地址**。站内渠道永远是 `forced`。类型没声明的渠道，策略页上也开不出来。短信必须给业务模板 —— 国内短信只能发审核过的模板；而且只发给**本人验证过**的手机号，管理员录入的号会记一行 `skipped / phone_unverified`，不发。

内置的类型和默认值：

| 类型 | 站内 | 邮件 | 短信 | 群机器人 |
|---|---|---|---|---|
| `workflow.remind` 审批催办、`workflow.timeout` 审批超时提醒 | 必发 | 默认开 | 默认关 | — |
| `workflow.sent_back` 申请被退回 | 必发 | 默认开 | — | — |
| `workflow.result` 审批结果 | 必发 | 默认关 | — | 可订阅 |
| `workflow.cc` 抄送、`workflow.withdrawn` 审批被撤回 | 必发 | 默认关 | — | — |
| `workflow.task_assigned` 新的待办 | 不写站内 | 默认关 | — | — |
| `announcement` 通知公告 | 必发 | — | — | 可订阅 |
| `open.webhook.disabled` Webhook 端点已停用 | 必发 | 默认开 | — | 可订阅 |
| `system` 系统通知、`export.done` / `export.failed` 导出完成 / 失败 | 必发 | 默认关 | — | — |

全员广播的类型（公告、每日问候）永远不走邮件和短信：站内一行广播，到外部渠道就成了全员群发。

业务代码只有一个入口：[`notification_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notification/service/notification_service.py) 里的 `create_in_tx(db, kind=..., user_ids=..., title=..., content=..., link=...)`。它在你的事务里写站内行和投递行，不 commit，返回一个 `Dispatch`；提交之后调它的 `after_commit()` 推 socket、踢 worker。

## 投递行写下去之后发生什么？

Celery 任务 `notification.deliver_pending` 每 15 秒扫一次，每次提交后也会立刻踢一脚。worker 用 `UPDATE … SET status = 'sending' WHERE id = ? AND status IN (…)` 抢占，rowcount 恰好是 1 才发。失败的按 60、300、1800、7200 秒退避重试（默认 `NOTIFICATION_RETRY_MAX = 4`）。短信和群机器人「可能已经发出去了」的结果（连上之后超时）记成 `unknown`，**不重试** —— 重试就是重复发。邮件则对连接错误和超时一律重试：重复一封邮件的代价小于漏掉一条催办。停在 `sending` 超过 600 秒的行归为 `unknown`，不会改回待发。

**消息推送 → 投递记录** 列出每一行的状态（`pending` / `sending` / `sent` / `failed` / `exhausted` / `skipped` / `unknown`）和原因，列表里手机号、邮箱打码，`failed` / `exhausted` / `unknown` 的行可以手动重发。默认保留 30 天。

## 群机器人能推到哪些平台？

飞书（含 `open.larksuite.com`）、钉钉、企业微信，在 **消息推送 → 群机器人** 里配置。机器人订阅的是声明了 `bot=True` 的类型，目前是通知公告、审批结果、Webhook 端点已停用。对着「你」说话的类型（抄送、新的待办、被退回）刻意不开放订阅：推到群里，每个人读到的都是「你」。设了发布范围的公告不推群 —— 机器人发进的是整个群，管不了范围；之后范围放宽成全员时补推一次。

- **一条通知 × 一个机器人一行投递**，和收件人有几个无关。
- **地址白名单**：Webhook 必须落在平台的官方前缀上（协议、主机、端口、路径逐项比；带 userinfo、带 `.` / `..` 路径段的拒绝；不跟随重定向）。私有化部署配 `NOTIFICATION_BOT_EXTRA_URL_PREFIXES`，生产环境只许 https。
- **签名**：飞书、钉钉支持加签；企业微信没有加签，地址里的 `key` 就是凭据。
- **限频**在发之前自己数：飞书 100 条/分钟 + 5 条/秒，钉钉、企业微信 20 条/分钟。超了就挪到下一分钟，不算一次重试。
- **只发纯文本**，不用 markdown：标题是用户填的，走 markdown 就能塞进一条看起来像系统发的链接。企业微信正文按 2048 **字节**截断，不是按字符。
- 读超时记为 `unknown`、不重试 —— 群里同一条出现两次，比重复一封邮件显眼得多。

机器人消息和邮件里的链接由 `NOTIFICATION_WEB_BASE_URL` 拼出（默认 `http://localhost:8888`），部署前要改成真实访问地址。接一个飞书机器人的完整步骤见[群机器人接入指南](https://github.com/yilecoding/fastapi-react-admin/blob/main/docs/guides/notify-bot.md)。

## Webhook 地址怎么防止落进日志？

Webhook 地址本身就是凭据：拿到它就能往群里发消息。地址和加签密钥用 `NOTIFICATION_ENCRYPT_SECRET_KEY`（32 字节，即 64 位十六进制）加密存储；没配这个密钥时直接拒绝保存，不会静默存明文。接口只返回打码后的 `webhook_hint`，入参里的 `webhook_url` / `sign_secret` 在操作日志里会被脱敏。

不那么显眼的一处是 httpx 自己：它在 INFO 级别会打一行 `HTTP Request: POST <完整 URL>`。第一次真发飞书时，token 就这样进了访问日志。第一版修复只管住了 API 进程，而真正往群里发消息的 Celery worker 有自己的日志配置。现在修复放在 [`common/log.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/log.py) 的模块顶层（`logging.getLogger('httpx').setLevel(logging.WARNING)`），有两条测试守着，其中一条在子进程里按 `celery -l info` 的方式配日志。

## 哪些渠道真发过？

| 渠道 | 真实环境的证据（出自插件分册） |
|---|---|
| 飞书群机器人 | 2026-10-30，开了签名校验的自定义机器人：测试消息 465 ms 进群；公告经 worker 投递，第 1 次就成功；错密钥回 `19021`，归为 `sign_failed`、不重试 |
| 钉钉、企业微信群机器人 | 还没在真群里发过，签名和回包分类靠官方文档 + 假服务器 |
| 短信插件 | 阿里云 2026-10-24 真发过（验证码模板）；腾讯云还没有，靠真 SDK 打本地假服务器的契约测试 |
| 经路由发的邮件 / 短信 | 测试里发送层是假的；邮件「5xx 永久失败、4xx 重试」的分类来自 aiosmtplib 的异常层级，不是真服务器的回包 |

## 目前不支持的

- 群机器人只按通知类型订阅，不能再按流程或部门过滤。
- 推群和推人走同一个入口，所以一条可推群的通知如果一个收件人都没有（比如管理员终止自己发起的单），群里也收不到。[群机器人指南](https://github.com/yilecoding/fastapi-react-admin/blob/main/docs/guides/notify-bot.md)的练习 2 专门讲怎么把两者拆开。
- 公告表单的发布范围下拉调的是用户 / 部门 / 角色列表接口，只有发公告权限、没有这三个列表权限的人，看到的是一行「没有权限查看这些数据」。

## 有哪些开关？

**界面上改的**（系统管理 → 参数配置），不用重启：

| 分组 | 键 | 默认值 | 说明 |
|---|---|---|---|
| 通知推送 | `NOTIFICATION_EXTERNAL_ENABLED` | `true` | 外部渠道总闸。关掉后只写站内消息，邮件 / 短信一条都不发（已经在排队的照常发完） |
| 通知推送 | `NOTIFICATION_RETRY_MAX` | `4` | 失败重试几次（不含第一次）；结果未知的不重试 |
| 通知推送 | `NOTIFICATION_DELIVERY_RETENTION_DAYS` | `30` | 投递记录保留天数，每天凌晨的日志清理一起删 |
| 邮件服务 | `EMAIL_HOST` · `EMAIL_PORT` · `EMAIL_SSL` | `smtp.qq.com` · `465` · `true` | 发信服务器 |
| 邮件服务 | `EMAIL_USERNAME` · `EMAIL_PASSWORD` | —— | 多数邮箱这里填「授权码」而不是登录密码；界面上以密文展示 |

**只能在 `.env` 改的**，改完重启后端（写在各插件 `plugin.toml` 的 `[settings]` 里，`conf.py` 里也声明成了字段，所以容器的环境变量能覆盖）：

| 键 | 默认值 | 说明 |
|---|---|---|
| `NOTIFICATION_ENCRYPT_SECRET_KEY` | 空 | 群机器人的地址和加签密钥落库加密用；留空 = 拒绝保存机器人，不存明文 |
| `NOTIFICATION_RETRY_BACKOFF_SECONDS` | `60,300,1800,7200` | 每次失败后等多久；次数比这张表长就一直用最后一档 |
| `NOTIFICATION_WEB_BASE_URL` | `http://localhost:8888` | 邮件里「去处理」链接拼绝对地址用，**上线前要改成真实地址** |
| `NOTIFICATION_BOT_TIMEOUT_SECONDS` | `5` | 调群机器人接口的超时 |
| `NOTIFICATION_BOT_EXTRA_URL_PREFIXES` | 空 | 官方地址之外放行的地址前缀（私有化部署的飞书 / 钉钉 / 企微），生产只许 https |
| `SMS_ENCRYPT_SECRET_KEY` | 空 | 短信厂商凭据落库加密用；留空 = 拒绝保存带凭据的配置 |
| `SMS_GLOBAL_HOURLY_MAX` | `500` | 全站每小时最多发多少条短信，防写错的循环刷光余额；0 = 不限 |
| `SMS_CAPTCHA_EXPIRE_SECONDS` · `SMS_CAPTCHA_MAX_ATTEMPTS` | `300` · `5` | 短信验证码的有效期和试错次数 |

## 代码在哪

- [`plugin/notification/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/notification) —— `kinds.py`（类型注册表）、`service/notification_service.py`、`service/routing.py`、`service/delivery_service.py`、`service/senders.py`、`bot_platforms.py`（地址前缀、签名、消息体、回包分类）、`audience.py`
- [`plugin/notice/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/notice) —— `service/notice_service.py`、`crud/crud_notice.py`；[`plugin/sms/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/plugin/sms) —— `sms_service.send()` 和阿里云 / 腾讯云适配
- 前端：[`packages/platform/src/pages/notification/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/notification)（铃铛、消息中心）、`notice/`（表单、读者抽屉、弹窗、横幅）、`notify-policy/`、`notify-delivery/`、`notify-bot/`、`profile/notify-prefs-panel.tsx`
- 分册：[`plugin/notification/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notification/AGENTS.md)、[`plugin/notice/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/notice/AGENTS.md)、[`pages/notification/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/notification/AGENTS.md)

## 怎么测的

pytest 在 `plugin/notification/tests/` 收集到 117 条（群机器人 66 条，假平台用 `httpx.MockTransport`；路由与投递 42 条；收件箱 9 条），`app/admin/tests/api_v1/test_notice_*.py` 公告 52 条，`plugin/sms/tests/` 133 条，`plugin/workflow/tests/test_notification_channels.py` 3 条。例如 `test_rollback_takes_the_delivery_rows_with_it`、`test_sms_needs_a_phone_the_owner_verified`、`test_read_all_does_not_acknowledge_for_the_reader`。按分册记录，公告二期那组测试在 PostgreSQL 16、SQL Server 2022、MySQL 8.4 上都跑过。Playwright 覆盖铃铛、公告、策略与个人偏好，还有一条群机器人用例：测试消息打到假飞书，按官方算法验签。

## 在演示站里试试

打开 [fra.wubunan.com](https://fra.wubunan.com/sign-in)，用 `admin` / `123456` 登录。铃铛在顶栏，侧边栏有 **消息中心**；公告在 **系统管理 → 通知公告**；通知策略、投递记录、群机器人在 **消息推送** 下；自己的渠道偏好在 **个人中心 → 通知偏好**。
