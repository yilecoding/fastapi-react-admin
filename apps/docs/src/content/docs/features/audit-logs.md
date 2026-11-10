---
title: 日志与审计
description: 登录日志（含锁定、强制下线等安全事件）、操作日志（自动脱敏）、数据变更记录（谁、什么时候、从哪来，把哪个字段从什么改成了什么，和操作日志互跳）；带签名的防篡改链，默认留存 180 天满足《网络安全法》的六个月下限。
sidebar:
  order: 4
---

系统留三种记录，回答三个问题：**登录日志**回答「谁、什么时候、从哪登录的，成没成功」，账号被锁、被强制下线这类安全事件也记在这里；**操作日志**回答「谁调了哪个接口、带了什么参数、结果如何、花了多久」，密码、令牌这类字段落库前就打码；**数据变更记录**回答「这条数据的哪个字段被谁从什么改成了什么」，和触发它的那次操作日志互相跳转。数据变更记录带一条签名链，记录被改、被删、被塞进来都能校验出来。三种记录默认都保留 180 天。

## 在界面上哪里找？

| 入口 | 路径 | 权限码 | 做什么 |
|---|---|---|---|
| **日志管理 → 登录日志** | `/log/login` | 查看 `log:login:list` · 导出 `export` · 清空 `clear` | 每次登录尝试和安全事件 |
| **日志管理 → 操作日志** | `/log/opera` | 查看 `log:opera:list` · 导出 `export` · 清空 `clear` | 每次接口调用；详情里有「这次改了什么」 |
| **日志管理 → 数据变更** | `/log/change` | 查看 `log:change:list` · 导出 `log:change:export` | 字段级的前后对比；超级管理员多一个「校验完整性」 |
| 用户、部门、角色、菜单、参数配置五个页面的行操作「变更记录」 | —— | `log:change:list` | 只看这一个对象的变更历史 |

- 登录日志和操作日志页**没有逐行删除**，只有「清空」：整张表删掉、不管当前的筛选条件。数据变更记录**不能删、也不能清空**，只会按保留天数被清理。
- ⚠️ 登录日志、操作日志两页的前端路由守卫目前认的是 `log:login:del` / `log:opera:del`，不是 `list` —— 只授了查看的角色打不开这两页。数据变更页认的是 `log:change:list`。
- 数据变更记录**不受数据范围约束**：有 `log:change:list` 的人看得到所有对象的变更。

## 登录日志记了什么？

每一行：用户名、成功 / 失败、原因、IP 和归属地（国家 / 地区 / 城市）、浏览器、操作系统、设备、时间，以及**事件类型**：

| 事件 | 什么时候记 |
|---|---|
| 登录 | 每一次登录尝试，成功和失败都记 |
| 账号被锁 | 密码连续输错到了阈值 |
| IP 被锁 | 同一个 IP 跨账号失败到了阈值 |
| 被强制下线 | 被管理员踢、改了密码、账号被停用 —— 记的是被踢那台设备的 IP 和浏览器 |

- 用户不存在和密码错，记的原因是同一句（和登录页上提示的一样）；「账号已锁」只在密码输对之后才会说出来。
- 开了二次验证的账号：密码对了、动态码还没输时**不记**，第二步通过时记一条「登录成功（二次验证）」，第二步失败也记。
- 手机验证码登录失败时，用户名一栏是匹配到的账号名；没匹配到就是打码的手机号（`138****1234`）。
- 第三方登录（GitHub / Google）只记成功。Swagger 调试口的登录不记。
- 归属地默认用内置的离线 IP 库（`ip2region`）查，纯 IPv6 地址查不出归属地；也可以改成在线查询或关闭。结果在 Redis 里缓存一天。

## 操作日志记了什么？打码怎么做的？

`/api/v1` 下的每个请求都记一行（包括 GET）：用户、方法、路径、接口说明、IP 与归属地、浏览器、请求参数、请求头、响应头、响应体、HTTP 状态、业务码、提示信息、耗时（毫秒）。

**不记的**：`OPERA_LOG_PATH_EXCLUDE` 里列的路径（接口文档、Swagger 登录口、第三方登录的跳转和回调）、OPTIONS 请求、请求还没处理完客户端就断开的（记成 499、不入库）。写日志走一个异步队列，队列满了（10 万条）新的会被丢弃并打警告。

**截断**：请求体超过 10 KB、或者没有声明长度的文件上传，记一个占位符；`application/octet-stream` 的请求体不读。响应体只记 JSON 和纯文本，超过 10 KB 截断，超过 5 MB 的 JSON 不解析。

**打码**在落库之前、截断之前做，不论嵌套多深（最多 20 层）：

- 按键名精确匹配：`password` · `old_password` · `new_password` · `confirm_password` · `captcha` · `otp` · `totp_secret` · `otpauth_uri` · `recovery_codes` · `mfa_token` · `access_token` · `refresh_token` · `token` · `api_key` · `secret_key` · `access_key_secret` · `mcp_token` · `webhook_url` · `sign_secret` · `import_token`（完整列表在 `conf.py` 的 `OPERA_LOG_REDACT_KEYS`）。
- 「键 + 值」形状的数据（比如参数配置的一行）：键名**看起来像密钥**（以 `PASSWORD`、`SECRET`、`TOKEN`、`API_KEY`、`CREDENTIAL` 等结尾，不分大小写）时，旁边的值打码。
- 请求头：`authorization`、`cookie`、`set-cookie`、`proxy-authorization`、`x-api-key`、`x-auth-token`。
- 宁可不记也不漏记：声明是 JSON 却解析不了的请求体不记；解析不了的 JSON 响应换成占位符。

有 `log:change:list` 的人打开一条写操作（GET 以外）的详情，能看到**「这次改了什么」**：这个请求引起的数据变更，最多列 50 条，更多的点「还有 N 条」跳到数据变更页按这次请求筛选。反过来，数据变更页的每一条也能跳回触发它的那条操作日志。两边靠请求的 trace_id 关联。

## 数据变更记录是怎么记下来的？

不是在每个接口里手写「记一笔」，而是挂在数据库会话上：事务提交前把这个事务里改了的对象逐个比对，生成「字段 · 旧值 · 新值」，**和业务数据在同一个事务里写入** —— 业务回滚了，变更记录也不会留下。同一个事务里同一个对象改了多次，只记一行最终结果。

main 上已经接入的对象：

| 对象 | 一起记在它名下的 |
|---|---|
| 用户 | 角色、二次验证的开关和恢复码、第三方账号的绑定解绑 |
| 部门 | |
| 角色 | 功能权限（菜单）、数据范围 |
| 菜单 | |
| 参数配置 | |

- **每一列都必须归类**：普通字段、引用（同时记下被引用对象当时的名称，比如部门改名之后，老记录里仍是当时的名字）、敏感、忽略、软删除标记。漏归类的列让后端**启动失败**，而不是悄悄不记。
- **敏感字段只记「改了」不记内容**：密码、恢复码、键名像密钥的参数配置值，界面上显示「已修改（不记录内容）」，导出的文件里也一样。
- **关联表记净变化**：「先全删再全加回来」而实际没变的，不记。
- **来源**：网页、AI 助手、导入、第三方登录、后台任务、系统，一眼看出是不是人在界面上点出来的。
- 一条语句改超过 500 行的批量操作，记成一行汇总。
- 抽屉里点某个字段名，只看这个字段的历史；数据变更页把字段写进地址栏，刷新还在。

## 怎么知道记录有没有被改过？

每一条数据变更记录写入时按顺序编号，并用 HMAC-SHA256 签名：签名覆盖这一行的内容**和上一行的签名**，连成一条链。改一行、删中间一行、删末尾几行、在中间塞一行、拿另一把密钥把整条链重签一遍，都会在校验时对不上。

三种方式校验，结果一样：

- 数据变更页上的「**校验完整性**」（只给超级管理员）
- 接口 `GET /api/v1/logs/changes/integrity`（只给超级管理员）
- 命令行 `fba data-change verify`，有问题时退出码为 1，方便放进定时巡检

签名密钥是 `.env` 里的 `DATA_CHANGE_CHAIN_KEY`，**只放环境变量、不进数据库**：拿到数据库权限的人改了记录、重算签名也对不上。它留空时用空密钥签名，只能防「手滑直接改库」，校验结果会说明这一点。设了就别换 —— 换了之后，旧记录会被单独列成「换密钥之前签的」。同时拿到数据库**和**这把密钥的人，这条链挡不住。

## 记录保留多久？

| 记录 | 默认 | 在哪改 |
|---|---|---|
| 登录日志、操作日志（以及开放接口调用日志、短信发送日志） | 180 天 | 「任务调度」里「清理历史日志」这条任务的参数 `{"days": 180}` |
| 数据变更记录 | 180 天 | 参数配置 →「日志」→ `DATA_CHANGE_RETENTION_DAYS`（1–3650） |
| 通知投递记录、Webhook 记录 | 30 天 | 各自在参数配置里的保留天数 |

清理任务 `maintenance.prune_logs` 每天 03:15 跑，按业务时间（登录时间、操作时间）每批 2000 行分批删。180 天来自《网络安全法》第二十一条「网络日志留存不少于六个月」；从 30 天改成 180 天的迁移**只改还停在 30 天的那条任务**，你自己改过的不动。清理数据变更记录时先挪动签名链的起点再删，所以清理之后校验仍然通过。

## 有哪些开关？

**界面上改的**：数据变更记录的保留天数（参数配置 →「日志」）、登录 / 操作日志的保留天数（任务调度里那条任务的参数），见上一节。

**只能在 `.env` 改的**，改完重启后端：

| 键 | 默认值 | 说明 |
|---|---|---|
| `DATA_CHANGE_CHAIN_KEY` | 空 | 防篡改链的签名密钥，64 位十六进制；生产环境建议设上，设了别换 |
| `IP_LOCATION_PARSE` | `offline` | 归属地：`offline` 离线库 / `online` 在线查询 / `false` 不查 |
| `TRUSTED_PROXIES` | `[]` | 反代地址；不填的话，部署在反代后面时日志里的 IP 全是反代的 |
| `OPERA_LOG_PATH_EXCLUDE` | 接口文档、第三方登录跳转等 | 不记操作日志的路径（精确匹配） |
| `OPERA_LOG_REDACT_KEYS` · `OPERA_LOG_REDACT_HEADERS` | 见上文 | 打码的键名和请求头 |
| `OPERA_LOG_BODY_MAX_SIZE` · `OPERA_LOG_RESPONSE_MAX_SIZE` | `10240` · `10240` | 请求体、响应体记多少字节 |
| `OPERA_LOG_RESPONSE_CONTENT_TYPES` | `application/json` · `text/plain` | 哪些类型的响应体会被记录 |
| `OPERA_LOG_QUEUE_MAXSIZE` | `100000` | 写日志队列的长度，满了丢弃 |

## 给自己的表接入数据变更记录

1. 在模块或插件目录下放一个 `data_change.py`，启动时自动扫描。
2. 调 `register_audited(...)` 登记模型，**把每一列归类**（字段 / 引用 / 敏感 / 忽略 / 软删除）；关联表用 `register_audited_set`，一对一的子表用 `register_audited_child`，记在主对象名下。
3. 每个字段的中文名、英文名进两份语言包和 `server-data-keys.json`（有测试核对）。
4. 不经过网页请求的入口（后台任务、命令行）用 `data_change_source(...)` 标明来源。
5. **别用会话看不见的写法**：裸 SQL 的 `text()` 增删改、语句式的 `insert(模型)`、直接拿 `connection()` 写 —— 生产代码里出现这些写法，静态守卫测试会失败。

新增像凭据的请求字段时，记得加进 `OPERA_LOG_REDACT_KEYS`：有一条测试扫描所有接口的 schema，像凭据却没打码的字段会让它失败。逐条的说明和踩过的坑在 [`common/data_change/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/data_change/AGENTS.md)。

## 它不做什么

- **不记**：个人偏好、密码历史、会话的建立与结束（这些在登录日志里）；裸 SQL、迁移脚本、种子数据造成的改动。
- 第三方登录失败、Swagger 调试口的登录不进登录日志。
- 请求的 trace_id 可以由客户端通过 `X-Request-ID` 头指定，所以「这次改了什么」的关联不能当成不可伪造的证据；防篡改链保护的是数据变更记录本身。
- 数据变更记录（含防篡改链）的测试在 CI 的 PostgreSQL、SQL Server 两个 job 上都跑，MySQL 上还没有验证过。
- 登录日志、操作日志的保留天数不在参数配置页上，要去改定时任务的参数。

## 代码在哪

- 登录日志：[`login_log_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/service/login_log_service.py) · IP 与浏览器解析 [`utils/request_parse.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/utils/request_parse.py)
- 操作日志：[`middleware/opera_log_middleware.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/middleware/opera_log_middleware.py) · 「像密钥的键名」判定 [`common/secret_keys.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/common/secret_keys.py)
- 数据变更：[`common/data_change/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/api/backend/common/data_change)（`capture.py` 捕获、`registry.py` 登记、`chain.py` 签名链）· 内置对象的登记 [`app/admin/data_change.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/data_change.py)
- 清理：[`tasks/maintenance/tasks.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tasks/maintenance/tasks.py) 的 `prune_logs`
- 前端：[`pages/log-login/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/log-login) · [`pages/log-opera/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/log-opera) · [`pages/log-change/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/log-change) · 各页面共用的「变更记录」抽屉 [`_shared/data-change/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/_shared/data-change)

## 怎么测的

后端连真实的数据库和 Redis：

- [`test_data_change.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/api_v1/test_data_change.py)（52 条）：生产代码里没有捕获不到的写法（静态守卫）、角色菜单记净变化并带菜单标题、重置密码只记「改了」、中间和末尾的记录被删能校验出来、换一种方式重签整条链也能发现、校验接口只给超级管理员。
- [`test_prune_logs.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/task/tests/test_prune_logs.py)（19 条）：按业务时间而不是写入时间清理、默认保留天数各处一致且不低于六个月、迁移只改还停在 30 天的那条任务、清理带签名的数据变更后链仍然校验通过。
- [`tests/test_opera_log_redaction.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/tests/test_opera_log_redaction.py)（25 条）：先打码再截断、客户端中途断开不记成成功、登录响应里的令牌被打码。
- [`test_login_events.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/tests/api_v1/test_login_events.py)：强制下线记下被踢的设备和是谁踢的。

浏览器端（Playwright）：[`data-change.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/data-change.spec.ts)（改部门名 → 行操作「变更记录」看到旧值 → 新值 → 数据变更页按对象筛 → 跳到这次请求的操作日志；操作日志详情「这次改了什么」→ 去数据变更看全部）、[`login-events.spec.ts`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/web/e2e/tests/login-events.spec.ts)（密码连续输错被锁 → 登录日志按「账号被锁」筛出来）。

## 在演示站里试试

[在线演示](https://fra.wubunan.com/sign-in)（`admin` / `123456`）：到「系统管理 → 部门管理」改一个部门的名字，再点这一行的「变更记录」，能看到旧名字 → 新名字；点进去跳到触发它的那条操作日志，看请求参数和耗时。`admin` 是超级管理员，数据变更页上的「校验完整性」也能点。演示站是共用的，改完请改回去。
