---
title: 能力开放（AK/SK 签名接口）
description: 给外部系统的只读开放接口：AK/SK + HMAC-SHA256 签名，scope、IP 白名单、防重放、限流、调用日志、增量同步与 Webhook。
sidebar:
  order: 6
---

能力开放插件让别的系统（HR、财务、数据仓库……）通过 `/api/open/v1` 从 fastapi-react-admin 拉取用户和部门，数据变了还能收到签名的 Webhook 推送。每个对接系统对应一个「应用」，发一对 Access Key / Secret Key。每个请求都用 HMAC-SHA256 签名（`FRA1-HMAC-SHA256`），再逐一核对应用的 scope、IP 白名单、有效期和限流。无论成功失败，每次调用都会落一条调用日志。

## 外部系统能调哪些接口？

| 接口 | scope | 返回字段 |
|---|---|---|
| `GET /api/open/v1/users` | `user:read` | `id` `username` `nickname` `dept_id` `status` `deleted` `created_time` `updated_time` |
| `GET /api/open/v1/depts` | `dept:read` | `id` `parent_id` `code` `name` `sort` `leader_id` `status` `deleted` `created_time` `updated_time` |

另有一个没有接口的 scope `workflow:read`，只用来授权订阅审批事件。这两个接口都是只读的，返回的是**全量**数据：开放接口显式跳过了行级数据权限。数据边界靠两件事守：

- 给应用授权哪些 scope
- 专门的对外 schema（[`schema/open_v1.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/schema/open_v1.py)），只放承诺给对方的字段，内部 schema 加字段不会跟着外泄

前缀刻意不放在 `/api/v1` 下：内部接口没有兼容承诺，对外的这一组有。管理员可以在应用管理页点「开放接口文档」，导出 OpenAPI JSON 交给对接方。

## 怎么拿到 AK 和 SK？

在「能力开放 → 应用管理」（`/open/app`，需要 `open:app:add`）里新建应用，会拿到：

- **Access Key**（`fra_ak_…`）：公开标识，可以写进配置文件。
- **Secret Key**（`fra_sk_…`）：**只显示一次**，丢了只能让管理员重置。只能放在服务端。

SK 是**加密存储，不是哈希**：验签时服务端要拿 SK 重算一遍 HMAC，所以必须能还原。加密密钥是 `OPEN_SECRET_KEY`（64 位十六进制，放 `.env`）。没配它时，新建应用和重置密钥都会明确报错拒绝，不会悄悄存成明文。列表和详情接口里只有 SK 的前几位，连密文都不返回。

每个应用还可以设置授权的 scope、IP 白名单（单个 IP 或 CIDR，留空 = 不限）、每分钟请求上限（留空 = `OPEN_RATE_PER_MINUTE`，默认 120）、可选的失效时间，以及启用 / 停用。

## 请求怎么签名？

每个请求带四个请求头：

```
X-Access-Key: fra_ak_xxxx
X-Timestamp:  1761009302000
X-Nonce:      8f1c2a9e4b7d4e05
X-Sign:       <hex>
```

`X-Timestamp` 是毫秒；`X-Nonce` 是每次请求都不同的随机串。待签名字符串是六段用 `\n` 连起来，依次是：大写的请求方法、请求行里的原样路径（不含查询串）、规范化查询串、时间戳、nonce、`hex(sha256(请求体))`（没有请求体时取空串的哈希）。然后 `X-Sign = hex(HMAC-SHA256(SK, 待签名字符串))`。

规范化查询串的拼法：把参数解码出来，名和值分别按 RFC 3986 重新编码（只有 `A-Z a-z 0-9 - _ . ~` 不编码，**空格编成 `%20` 而不是 `+`**）。编码**之后**再按「参数名，然后值」排序，用 `&` 连起来。

测试向量（摘自[对接文档](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/README.md)）：SK 取 `fra_sk_TEST-ONLY-do-not-use-in-production`，时间戳 `1761009302000`，nonce `8f1c2a9e4b7d4e05`。请求 `GET /api/open/v1/depts?name=%E5%BC%A0%20%E4%B8%89&b=1&a=2&a=1` 的待签名字符串应当是：

```
GET
/api/open/v1/depts
a=1&a=2&b=1&name=%E5%BC%A0%20%E4%B8%89
1761009302000
8f1c2a9e4b7d4e05
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

`X-Sign` 应当是 `2717e8c4f65ffb9b621cfd19ba928706143e5cec1e80bb4a15d7b4a35ff0aae0`。其余向量见 [`sdk/test_vectors.json`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/test_vectors.json)。用 Python 参考实现：

```python
import requests
from fra_open_sign import sign_headers

url = 'https://admin.example.com/api/open/v1/users?limit=500'
resp = requests.get(url, headers=sign_headers('GET', url, b'', access_key=AK, secret_key=SK))
```

对接文档里点名的四个高发错误：查询参数里的 `+` 和 `:` 没先编码（应写成 `updated_since=2026-10-20T00%3A00%3A00%2B08%3A00`）；签了一个对象再让 HTTP 库重新序列化，而不是签**实际发出去的那串字节**；客户端时钟和服务端差超过 5 分钟；重试时没换 nonce。

签名对不上时，401 响应里的 `data.string_to_sign` 就是服务端拼出来的待签名字符串（不含密钥），拿它和自己拼的逐行比，就知道是哪一段不一样。

Host 不参与签名，前面多一层反向代理改了 Host 也不会全挂。但**改写路径**就会挂，所以 `apps/web/nginx.conf` 对 `/api/` 是原样透传的。

## 怎么防重放？

两道检查配合（[`gateway/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/auth.py)）：

- **时间戳窗口**：`X-Timestamp` 和服务端时间相差超过 `OPEN_SIGN_WINDOW_SECONDS`（300 秒）就拒绝，返回 401，并带上 `data.server_time`。
- **nonce**：按应用存进 Redis（`SET NX`），存活窗口的 2 倍，即 600 秒。

nonce 存活时间是窗口的两倍，所以窗口内的重放一定撞上 nonce，窗口外的重放一定撞上时间戳。

顺序上是**先验签、后消费 nonce**：签名不对的请求不占用 nonce，对方修好签名后用同一个 nonce 重发不会被当成重放。真正的重放签名一定是对的，照样会撞上 nonce 这一步。守卫测试是 `test_bad_signature_does_not_burn_the_nonce`，把两步顺序调换后有 11 条测试变红。

完整的检查顺序：

| # | 检查 | 失败时 |
|---|---|---|
| 1 | 四个请求头齐全 | 400 `open.missing_param` |
| 2 | AK 存在、应用已启用且未过期 | 401 `open.invalid_key` / `open.app_disabled` / `open.app_expired` |
| 3 | 来源 IP 在白名单内 | 403 `open.ip_denied` |
| 4 | 时间戳在窗口内 | 401 `open.timestamp_expired` |
| 5 | 签名正确（常量时间比较） | 401 `open.sign_mismatch` |
| 6 | nonce 没用过 | 401 `open.nonce_reused` |
| 7 | 应用被授权了这个接口的 scope | 403 `open.scope_denied` |
| 8 | 没超限流 | 429 `open.rate_limited`，带 `Retry-After` |

限流**按应用计，不按 IP**。白名单比对用的来源 IP 来自 `get_request_ip`：只有直连对端在 `TRUSTED_PROXIES`（默认空）里时，它才采信 `X-Forwarded-For` / `X-Real-IP`。部署在 nginx 或负载均衡后面时要把代理地址配进去，否则白名单看到的是代理的地址，不是调用方的。

## 调用日志记了什么？

`/api/open/v1` 下的每个请求，无论成功失败，都在 `open_api_log` 落一行；连 AK 无效、识别不出应用的请求也记（应用为空）。每行记录：

- 应用编码和名称（调用时的快照）、请求里带的 AK
- 接口、它需要的 scope、应用当时有没有授权
- 来源 IP、在不在白名单里
- 参数、脱敏后的请求头
- 响应头、响应体（超长截断）
- `ok` 或失败码、返回条数、耗时

`X-Sign` **刻意不打码**：它是一次性签名，nonce 已经消费，没法重放，留着正好和服务端的签名比对。从应用管理页某一行的「调用日志」进入（路由 `/open/log`）。清理和登录日志、操作日志走同一个保留期（种子里是 30 天）。

单独建表而不复用操作日志，有两个原因：操作日志只记 `/api/v1` 开头的请求；而对接时最要看的失败原因，多半发生在识别出应用之前。

## 增量同步怎么用？

两个接口都接受 `updated_since`（带时区的 ISO 8601，第一次全量同步不传）、`cursor`（上一页的 `next_cursor`，原样带回）和 `limit`（1–500，默认 100）。返回 `{"items": [...], "next_cursor": "...", "has_more": true}`，一直翻到 `has_more = false`。下一次增量同步，`updated_since` 传你收到的最大变更时间。

- 已删除的记录**也会返回**（`deleted: true`），收到就把本地那条删掉。
- 按变更时间（`COALESCE(updated_time, created_time)`）加 `id` 排序，用游标而不是 offset 翻页：同步过程中别人改了数据，也不会漏、不会重。边界上那一条可能再收到一次，按 `id` 覆盖即可。
- ID 一律是字符串：19 位雪花 ID 超出 JavaScript 的安全整数范围。

这里在 SQL Server 上踩过一个真坑。`datetimeoffset(7)` 精确到 100 纳秒，Python 的 `datetime` 只到微秒，种子里 `GETDATE()` 写的时间读出来被截掉一截。结果游标永远越不过那一行，同一页无限返回。CI 的 SQL Server 任务因此连续超时三次，本地复现率 58%。现在查询先 `CAST(... AS DATETIMEOFFSET(6))`，取值、比较、排序都用同一个微秒精度的值（[`service/sync_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/sync_service.py)）。

## Webhook 怎么收？

在「能力开放 → 应用管理 → Webhook」里登记接收地址（每个应用最多 10 个），选要听的事件。能订阅的事件受应用已授权的 scope 限制。签名密钥（`whsec_…`）只显示一次，和 SK 是两把不同的密钥。

| 事件 | 需要的 scope |
|---|---|
| `user.created` · `user.updated` · `user.status_changed` · `user.deleted` | `user:read` |
| `dept.created` · `dept.updated` · `dept.deleted` | `dept:read` |
| `workflow.instance.started` · `.approved` · `.rejected` · `.withdrawn` · `.terminated` | `workflow:read` |

推送的 `data` **只有标识和状态**，不含表单内容、手机号、邮箱。要详情，用 AK/SK 调上面的接口去拉。

签名遵循 [Standard Webhooks](https://www.standardwebhooks.com/)：

- `签名 = base64(HMAC-SHA256(key, "{webhook-id}.{webhook-timestamp}.{请求体原文}"))`，其中 `key` 是去掉 `whsec_` 前缀后 base64 解码得到的字节。
- 重置密钥后的 24 小时内，`webhook-signature` 里会有两个签名（空格分隔），任一个对上即可。

投递规则：15 秒内回 2xx 算成功；3xx 算失败，**不跟随重定向**；回 `410 Gone` 端点立即停用；其他情况在 15 秒、5 分钟、1 小时、6 小时后重试，共 5 次。投递是**至少一次**、不保证顺序，请按 `webhook-id` 去重。连续失败 20 次**且**持续超过 24 小时，端点会被自动停用，并给应用创建人发一条[通知](/zh-cn/features/notifications/)。

防 SSRF：接收地址只收 https，主机名**每次尝试前**都重新解析，解析到任何非公网地址就拒绝。检查和建连之间的 DNS 重绑定是已知的残余风险，缓解放在部署层，代码里没有。

出站签名和 Standard Webhooks 规范 README 里的示例签名逐字一致（`v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`）。不过只对 mock 和本机起的接收端测过，**没有对真实公网接收端验证过**。

## 有哪些 SDK？

| 语言 | 文件 | 函数 |
|---|---|---|
| Python 3.10+ | [`sdk/python/fra_open_sign.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/python/fra_open_sign.py) | `sign_headers`、`verify_webhook` |
| Node.js 18+ | [`sdk/node/fra-open-sign.mjs`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/node/fra-open-sign.mjs) | `signHeaders`、`verifyWebhook` |
| Java 11+ | [`sdk/java/FraOpenSign.java`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/sdk/java/FraOpenSign.java) | `signHeaders`、`verifyWebhook` |

每份都是单文件、只用标准库，整个文件拷走即可。它们只负责**签名和 Webhook 验签**，不是带类型模型的完整 API 客户端。

## 怎么测的？

| 文件 | `def test_` 数 | 覆盖 |
|---|---|---|
| `test_open_api.py` | 21 | `/api/open` 下每个路由都挂了鉴权、每种失败码、重放、限流、调用日志、增量同步 |
| `test_open_signature.py` | 8 | 服务端和 SDK 对测试向量、README 里贴的就是同一组向量 |
| `test_open_apps.py` | 14 | SK 明文只出现在新建那次响应里并在操作日志中打码、没配 `OPEN_SECRET_KEY` 时拒绝保存、重置 / 停用即刻生效 |
| `test_webhooks.py` | 35 | 签名、重试、自动停用、SSRF、真实写操作是否发出事件 |

Python 和 Node 的签名在 pytest 里对测试向量。机器上有 `node` / JDK 时，Node 和 Java 的 Webhook 验签也会跑。Java 的 `signHeaders` 不在自动化测试里：最近一次是 2026-11-01 手动编译、跑了三组向量，签名全部对上。Playwright 用例 `webhook.spec.ts` 在本机起一个接收端，按规范自己重算每一条签名。

## 代码在哪

- [`gateway/signature.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/signature.py)：规范化查询串、待签名字符串、常量时间比对
- [`gateway/auth.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/auth.py)：八步检查、`DependsOpenApp`、scope 注册表
- [`gateway/route.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/gateway/route.py)：调用日志
- [`service/sync_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/sync_service.py)：增量同步
- [`service/webhook_delivery.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/webhook_delivery.py) · [`service/webhook_sign.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/service/webhook_sign.py)：Webhook 投递与签名
- [`plugin.toml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/plugin.toml)：配置项 · [`README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/plugin/open/README.md)：给对接方看的完整对接文档
