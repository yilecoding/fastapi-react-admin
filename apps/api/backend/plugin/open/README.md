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
