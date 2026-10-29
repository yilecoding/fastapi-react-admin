# 能力开放 · 对接文档

给对接的外部系统看的。管理员在后台「能力开放 → 应用管理」里给你建一个应用，你会拿到：

| 项 | 说明 |
|---|---|
| Access Key（AK） | `fra_ak_` 开头，公开标识，可以写进配置文件 |
| Secret Key（SK） | `fra_sk_` 开头，**只显示一次**，丢了只能让管理员重置。只能放在你的服务端，不要写进浏览器 / App 代码 |
| 接口地址 | `https://<域名>/api/open/v1` |
| 授权接口 | 你能调哪几个接口，没授权的调用返回 403 |

接口清单（OpenAPI JSON）可以让管理员在应用管理页点「开放接口文档」导出给你。

## 1. 签名：FRA1-HMAC-SHA256

每个请求带四个请求头：

```
X-Access-Key: fra_ak_xxxx
X-Timestamp:  1761009302000        # 当前时间，毫秒
X-Nonce:      8f1c2a9e4b7d4e05     # 每次请求不同的随机串
X-Sign:       <hex>
```

待签名字符串是六段用 `\n` 连起来：

```
METHOD                 # 大写，如 GET
PATH                   # 请求行里的路径，不含查询串，如 /api/open/v1/users
CANONICAL_QUERY        # 见下
TIMESTAMP              # 和 X-Timestamp 一样
NONCE                  # 和 X-Nonce 一样
hex(sha256(请求体))     # 没有请求体时是空串的哈希 e3b0c442…b855
```

`X-Sign = hex(HMAC-SHA256(SK, 待签名字符串))`

**CANONICAL_QUERY**：把查询参数解码出来，名和值分别按 RFC 3986 重新编码（只有 `A-Z a-z 0-9 - _ . ~` 不编码，
**空格编码成 `%20` 而不是 `+`**），再按「参数名，然后值」排序，用 `&` 连起来。没有查询参数时是空串。

### 最容易出错的四处

1. **查询参数里的 `+` 和 `:` 要先编码再发**。`updated_since=2026-10-20T00:00:00+08:00` 原样发出去，`+` 会被当成空格。
   发 `updated_since=2026-10-20T00%3A00%3A00%2B08%3A00`
2. **请求体要签实际发出去的那串字节**。先序列化成字节、签它、再原样发它；不要签一个对象再让 HTTP 库重新序列化
3. **时钟**：服务端只接受和自己相差 ±5 分钟以内的时间戳。超出时错误响应里带着服务端的当前时间（`data.server_time`）
4. **同一个 nonce 只能用一次**（10 分钟内）。重试时要换新的 nonce、重新签名

签名不匹配时，错误响应里的 `data.string_to_sign` 是**服务端拼出来的待签名字符串**（不含密钥）。
拿它和你自己拼的逐行比对，就知道是哪一段不一样。

### 测试向量

用这组固定值验证你的实现（这组 SK 只用于测试，服务端不存在）：

```
SK        = fra_sk_TEST-ONLY-do-not-use-in-production
TIMESTAMP = 1761009302000
NONCE     = 8f1c2a9e4b7d4e05
```

| 用例 | 请求 | 期望的 X-Sign |
|---|---|---|
| 查询参数已编码 | `GET https://admin.example.com/api/open/v1/users?updated_since=2026-10-20T00%3A00%3A00%2B08%3A00&limit=500` | `16213dc8c58c28affdd4254a02626c39e0f05635f67a58312a86c9623b68b5fd` |
| 参数乱序、同名参数、空格与中文 | `GET https://admin.example.com/api/open/v1/depts?name=%E5%BC%A0%20%E4%B8%89&b=1&a=2&a=1` | `2717e8c4f65ffb9b621cfd19ba928706143e5cec1e80bb4a15d7b4a35ff0aae0` |
| JSON 请求体 | `POST https://admin.example.com/api/open/v1/echo`，请求体 `{"code":"FIN_SYS","items":[1,2,3]}` | `ed1172b1d94903a6d34c94de6c0ff25d9f4edc5dbcb74633a4dff6b5b8e9d119` |

第二个用例的待签名字符串：

```
GET
/api/open/v1/depts
a=1&a=2&b=1&name=%E5%BC%A0%20%E4%B8%89
1761009302000
8f1c2a9e4b7d4e05
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

完整的向量（含每个用例的待签名字符串）在 `sdk/test_vectors.json`。

### 参考实现

都只用标准库，整个文件拷走即可；三份都对上面的测试向量验证过（服务端测试里也会跑 Python 和 Node 那两份）：

| 语言 | 文件 |
|---|---|
| Python 3.10+ | `sdk/python/fra_open_sign.py` |
| Node.js 18+ | `sdk/node/fra-open-sign.mjs` |
| Java 11+ | `sdk/java/FraOpenSign.java` |

```python
import requests
from fra_open_sign import sign_headers

url = 'https://admin.example.com/api/open/v1/users?limit=500'
resp = requests.get(url, headers=sign_headers('GET', url, b'', access_key=AK, secret_key=SK))
```

## 2. 响应与错误

响应信封：`{"code": 200, "msg": "请求成功", "data": {...}, "trace_id": "..."}`。HTTP 状态码和 `code` 一致。
报问题时请带上 `trace_id`（响应头 `X-Request-ID` 里也有）。

| HTTP | 原因 | 怎么处理 |
|---|---|---|
| 400 | 缺签名请求头 / cursor 无效 / 参数不合法 | 看 `msg` |
| 401 | AK 无效 · 应用已停用 · 应用已过期 · 时间戳超窗 · 签名不匹配 · nonce 重复 | 看 `msg`；签名不匹配看 `data.string_to_sign`，时间戳看 `data.server_time` |
| 403 | 来源 IP 不在白名单 · 应用没被授权调这个接口 | 联系管理员 |
| 429 | 超过每分钟请求上限 | 按响应头 `Retry-After`（秒）等待后重试 |

## 3. 增量同步

`GET /api/open/v1/users` · `GET /api/open/v1/depts`

| 参数 | 说明 |
|---|---|
| `updated_since` | 只要这个时间之后变更过的（**含删除**），带时区的 ISO 8601。第一次全量同步不传 |
| `cursor` | 上一页返回的 `next_cursor`，原样带回 |
| `limit` | 每页条数，1–500，默认 100 |

返回 `{"items": [...], "next_cursor": "...", "has_more": true}`。一直带着 `next_cursor` 翻到 `has_more = false`。
下一次增量同步：`updated_since` 传你上次收到的最大变更时间（`updated_time`，为空时取 `created_time`）。
边界上那一条可能会再收到一次，按 `id` 覆盖即可。

- 已删除的记录**也会返回**，`deleted: true` —— 收到就把你本地那条删掉
- 按「变更时间 + ID」排序，同步过程中别人改了数据也不会漏、不会重
- **ID 一律是字符串**（19 位雪花 ID，超出 JavaScript 的安全整数，当数字解析会丢精度）
- 时间一律是带时区的 ISO 8601（`2026-10-21T09:12:03+08:00`）

用户字段：`id` `username` `nickname` `dept_id` `status`（0 停用 1 正常） `deleted` `created_time` `updated_time`

部门字段：`id` `parent_id` `code` `name` `sort` `leader_id` `status` `deleted` `created_time` `updated_time`

## 4. 接收事件（Webhook）

不想定时来拉，可以让管理员在「应用管理 → Webhook」里登记你的接收地址、选好要听的事件。
事件一发生，这边就带签名 `POST` 过去。拿到的东西：

| 项 | 说明 |
|---|---|
| 签名密钥 | `whsec_` 开头，**只显示一次**。和 SK 是两把不同的密钥 |
| 能订阅的事件 | 只能是应用已授权的接口对应的那些（订阅 `user.*` 要先授权「读取用户」，审批事件要授权 `workflow:read`） |

### 请求长什么样

```
POST <你的地址>
content-type: application/json
webhook-id: 2227231048117391360          # 事件 ID：重试时不变，按它去重
webhook-timestamp: 1761750000            # 这一次尝试的时间（秒）
webhook-signature: v1,<base64>           # 密钥轮换的 24 小时里会有两个，空格分隔

{"type":"dept.updated","timestamp":"2026-10-29T18:00:00+08:00","data":{"id":"2048601263515500544","code":"HQ","name":"总部","parent_id":null,"status":1}}
```

`data` **只有标识和状态**，不含表单内容、手机号、邮箱。要详情，用这个应用的 AK/SK 调第 3 节的接口去拉 ——
读权限只有一条路，走授权和调用日志。

| 事件 | 什么时候 | data |
|---|---|---|
| `user.created` · `user.updated` · `user.status_changed` · `user.deleted` | 新建（含批量导入、第三方登录首次建号）· 改资料 · 启用 / 停用 · 删除 | `id` `username` `dept_id` `status` |
| `dept.created` · `dept.updated` · `dept.deleted` | 新建 · 修改 · 删除 | `id` `code` `name` `parent_id` `status` |
| `workflow.instance.started` · `.approved` · `.rejected` · `.withdrawn` · `.terminated` | 发起 · 通过 · 驳回 · 撤回 · 终止 | `id` `definition_code` `title` `status` `initiator_id` `biz_type` `biz_id` |

管理员点「发测试」时你会收到一条 `{"type":"ping", ...}`，不用处理，回 2xx 即可。

### 验签

遵循 [Standard Webhooks](https://www.standardwebhooks.com/)：

```
签名 = base64( HMAC-SHA256( key, "{webhook-id}.{webhook-timestamp}.{请求体原文}" ) )
key  = 去掉 whsec_ 前缀之后 base64 解码得到的字节
```

- 🔴 **拿收到的原始字节算**，不要先 `json.loads` 再 `json.dumps` 回去 —— 字节一变签名就对不上
- `webhook-timestamp` 和你的时间差超过 5 分钟就拒掉（防重放）
- 头里可能有两个签名（管理员刚重置过密钥，旧的还会一起签 24 小时），**任一个**对上即可

三份参考实现里都有 `verify_webhook`（Python `verify_webhook(headers, body, secret)` · Node `verifyWebhook(headers, body, secret)` ·
Java `FraOpenSign.verifyWebhook(headers, body, secret)`），也可以直接用 Standard Webhooks 各语言的官方库。
测试向量在 `sdk/test_vectors.json` 的 `webhook` 一节（就是规范 README 里那一组）：

```
secret     whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw
webhook-id msg_p5jXN8AQM9LWM0D4loKWxJek
timestamp  1614265330
body       {"test": 2432232314}
signature  v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=
```

### 你要回什么

| 你回 | 这边怎么办 |
|---|---|
| 2xx（15 秒内） | 成功 |
| 3xx | 失败，**不跟随重定向** —— 把地址改成最终那一个 |
| 410 Gone | 不再重试，端点立即停用 |
| 其他 / 超时 / 连不上 | 失败，15 秒 / 5 分钟 / 1 小时 / 6 小时后重试，共 5 次 |

- **至少一次投递**：同一个事件可能收到不止一次（比如你处理完了但响应在路上丢了），按 `webhook-id` 去重
- **不保证顺序**：重试会让后发生的先到。按 `data` 里的状态或你自己再拉一次的结果为准，别按到达顺序
- 连续失败 20 次**且**持续超过 24 小时，端点会被自动停用，管理员会收到通知。修好之后由管理员重新启用、批量重发
- 先回 2xx 再慢慢处理：别在请求里做耗时的事，超过 15 秒这边就当失败了
