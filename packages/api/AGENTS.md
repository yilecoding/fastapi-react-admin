# packages/api —— 后端契约，两端共用的那一份

> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 读到本目录下的文件时才加载它。

**最底层之一**（和 `packages/i18n` 同一个物种）：**不依赖任何 workspace 包**，
也不依赖任何运行时 —— 没有 DOM、没有 React Native、没有 React。

依赖方向：**`i18n` / `api` ← `ui` ← `platform` ← `apps/web`**，
而 `apps/mobile` **直接依赖这两个底层包**。

## 🔴 只有 `code === 200` 算成功，HTTP 状态码不足以判断成败

`response_base.fail()` 返回的是 **HTTP 200 + `code: 400`**
（`backend/common/response/response_schema.py`）。后端只用三个信封码 ——
`200`（成功）/ `400`（失败）/ `500`（服务端错误），加上 `40001` 那类业务码
（它们经 `_get_exception_code` 降级后配的是 HTTP 400）。

**这条踩过一次，而且两端各有一份。** 客户端只看 `!res.ok` 的话，所有 `fail()`
都被读成成功 —— 而 `count > 0 ? success() : fail()` 这个形状在 handler 里到处都是
（`/sys/users/me/nickname` · `/me/avatar` · `/me/timezone` · `/sys/configs/{pk}` …）。

⚠️ **一条需要纠正的说法。** 这里原来断言「设一个和库里一样的值 → 0 行 →
`fail()`，界面上表现为『保存成功、页面退回、值没变』」。**在 SQL Server 上那是错的**：

| 方言 | 设同值时的 rowcount | 接口返回 |
|---|---|---|
| SQL Server（aioodbc） | **匹配**行 = 1 | `code: 200` |
| PostgreSQL（asyncpg） | 匹配行 = 1 | `code: 200` |
| MySQL（asyncmy，本仓库**没**设 `CLIENT_FOUND_ROWS`） | **变更**行 = 0 | `code: 400` |

**同一个接口在三个方言上行为不同**，而本仓库宣称支持三种数据库。
实测钉在 `backend/app/admin/tests/api_v1/test_me_envelope.py`（那条测试自己
按 `DATABASE_TYPE` 分支，所以换方言跑也不会变成假失败）。

判定本身不受影响：`fail()` 该当成失败，无论它因为什么原因发生。

所以这个判定收进 `resolveEnvelope()`，**两端共用**：

```ts
const outcome = resolveEnvelope<T>(res, parsedBody)
if (!outcome.ok) throw outcome.error   // 401 由调用方自己决定怎么处理
return outcome.data
```

⚠️ `resolveEnvelope` 是**纯判定函数，不碰 401 刷新** —— 刷新在
`createApiClient` 里集中做（单飞 + 重放一次），**两端共用同一份**，
调用方不需要自己判 `isUnauthorized`。拆开只是职责划分：这里回答
「这次响应算成功还是失败」，刷新要访问注入的 token 存储、还要能重放请求。

（这句话曾经写的是「那一步两端机制不同，调用方自己判」—— 那是**传输层还没
收进这个包之前**的状态，现在不成立了。）

## 客户端也在这里：`createApiClient()`

一开始只共享契约、两端各写一份传输层。代价已经付过一次：上面那个
「HTTP 200 + code 400」的坑**两端各有一份**，改一边不修另一边。

现在传输层收进 `src/client.ts`，**平台差异全部走注入，包里一个
`if (platform)` 都没有**：

```ts
const client = createApiClient({
  getBaseUrl: () => serverStore.current(),   // 🔴 现取，不是构造时定死
  getToken: () => tokenStore.get(),          // 🔴 同步读
  setToken: (t) => tokenStore.set(t),
  clearToken: () => tokenStore.clear(),
  getLanguage: () => currentLanguage(),
})
```

|            | web                          | mobile                       |
|------------|------------------------------|------------------------------|
| base URL   | `import.meta.env`（编译期）  | `serverStore`（运行时可改）  |
| token      | `sessionStorage`             | `expo-secure-store` + 内存   |
| 语言       | app 层 `setApiLanguage()`    | `currentLanguage()` 直接读   |
| refresh    | `credentials: 'include'`     | RN 自带 cookie jar           |
| 各自加的   | multipart 上传 / 字节下载    | 网络错误文案 i18n            |

**共享的是**：信封成败语义、`ApiError`、401 单飞刷新、`Accept-Language`、
生成的接口类型、`PageData`。两端各自的文件（`packages/platform/src/api-client/client.ts`
和 `apps/mobile/src/lib/api.ts`）现在都只剩「一次实例化 + 各自那一两样额外能力」。

🔴 **要改重试 / 错误判定 / 头，改这个包。** 往两端任何一份里补逻辑，
就是把上面那个坑重新造一遍。

### 🔴 `baseUrl` 必须走**每请求**覆盖，不能传给 `createClient`

`openapi-fetch` 在 `createClient` 里就把 `baseUrl` 解构出来固化了：

```js
let { baseUrl = '', ... } = { ...clientOptions }   // v0.15.2 src/index.js:26
```

那个 `{ ...clientOptions }` 展开会把 getter **求值一次**。所以
`createClient({ get baseUrl() { return store.current() } })` 看起来很聪明，
实际只在模块加载时读了一遍 —— 移动端在「设置 → 服务器」里改完地址，
请求照旧发去旧地址，**而且不报错**。

正确的做法是每请求带上（`coreFetch` 里的 `localBaseUrl`，同文件 :45/:58）：

```ts
const merged = { baseUrl: config.getBaseUrl(), ...init, headers: … }
```

⚠️ 顺带一个同源的性质：`fetch` 也是 `createClient` 时快照的
（`fetch: baseFetch = globalThis.fetch`）。想换 fetch 实现只能在建客户端**之前**换。

### 路径里内联的 query 是安全的

123 个调用点都写成 `api.GET('/api/v1/x?page=1&size=50')` 而不是用
`params.query`。`createFinalURL` 是 `${baseUrl}${pathname}` 字符串拼接、
只有在 `params.query` 非空时才追加 `?…`（src/index.js:629），所以内联的
query 原样透传。**实测过**（见下面「怎么验」）。

### `openapi-fetch` 在 React Native 上能跑

移动端一开始没用它 —— 当时的理由是 `schema.d.ts` 住在 `packages/platform` 里、
而移动端不能依赖那个包（web 形状：TanStack Router / react-dom / zustand /
socket.io）。契约搬到本包之后这个理由就没了。

核过它用到的 Web API，**`new URL()` 用了 0 次**（RN 的 `URL` 是个不完整 shim，
这一条是关键）：

| 用到的 | RN 有没有 |
|---|---|
| `fetch` / `Request` / `Response` / `Headers` | 有（whatwg-fetch over XHR） |
| `FormData` / `URLSearchParams` | 有 |
| `response.body`（流） | **只在 `parseAs: 'stream'` 时用，我们不用** |
| `new URL()` | 用了 0 次 |

`credentials: 'include'` 在 RN 上是安全的：whatwg-fetch 只在 `'include'` 时
置 `withCredentials = true`、`'omit'` 时置 `false`，而 RN 的 `XMLHttpRequest`
默认就是 `true`（`XMLHttpRequest.js:157`）。**反过来才危险** —— 传
`'same-origin'` 会走到 `false` 分支，把 cookie jar 关掉，refresh 就静默失效。

### 怎么验（这层没有 E2E，靠一次性探针）

Hermes 包里能确认它真的被打进去了：

```bash
cd apps/mobile && npx expo export --platform android --output-dir /tmp/exp
grep -a -F 'onRequest: must return new Request()' /tmp/exp/_expo/static/js/android/*.hbc
```

⚠️ **grep Hermes 包里的中文要转 UTF-16LE** —— Hermes 的字符串表里
非 ASCII 是 UTF-16 存的，直接 grep UTF-8 一条都不匹配（很容易误判成
「文案没打进去」）：

```bash
printf '%s' '连不上服务器' | iconv -f UTF-8 -t UTF-16LE | grep -c -a -F -f - /tmp/exp/_expo/static/js/android/*.hbc
```

行为本身用一个 stub fetch 的探针覆过 7 组：baseUrl 运行时可改 · 内联 query
透传 · 两个头 · body 序列化 · **HTTP 200 + code 400 判失败** · 3 个并发 401
只刷 1 次并全部重放 · 刷新失败清 token 并回调。

⚠️ 写这类探针时注意上面那条 `fetch` 快照 —— 建完客户端再换
`globalThis.fetch` 是**无效**的，探针自己会先假绿一次（实测踩到了）。

## 类型推断：`src/types.ts`（移动端已切，web 端还没）

路径、查询参数名、请求体、返回字段全部从 `schema.d.ts` 推出来：

```ts
const me = await api.GET('/api/v1/sys/users/me')            // me.nickname 有类型
await api.PUT('/api/v1/sys/notifications/{pk}/read', { params: { path: { pk: n.id } } })
await api.GET('/api/v1/sys/notifications', { params: { query: { page: 1, size: 50 } } })
```

在它之前 `api.GET<T>()` 的 `T` 是**手写**的：123 个调用点里 71 个自己声明了
一遍返回结构，**和 `schema.d.ts` 从来没对过账**。写错一个字段名没有任何信号 ——
界面上就空一格。移动端更彻底，整份 DTO 是手抄的（`src/lib/contract.ts` 已退役）。

**实测**（突变验证，4/4 全抓）：字段名写错 → `TS2551 Did you mean 'timezone'?`；
路径写错 → `TS2345 not assignable to PathsWithMethod`；请求体字段写错 →
`TS2561`；查询参数名写错 → `TS2561`。

### 🔴 不要用条件展开传查询参数

```ts
params: { query: { page: 1, ...(cond ? { unread: true } : {}) } }   // ❌
params: { query: { page: 1, unread: cond ? true : undefined } }     // ✅
```

**展开进来的属性绕过 TS 的多余属性检查。** 实测：`unreadd` 经展开是 **0 错误**，
直接写是 1 错误。该省的参数传 `undefined` —— openapi-fetch 的 querySerializer 跳过它。

### 🔴 不要在外面再包一层函数转发那五个方法

包一层就把 `Paths` 泛型擦成 `Promise<unknown>` —— 推断全部失效，**而且不报错**，
只是所有调用点悄悄退回 `unknown`。要加行为走 `ApiClientConfig` 上的注入点
（移动端的网络错误文案本来包在外面，正是为此改成了 `onNetworkError`）。

### ⚠️ 外键的类型曾经是错的 —— 已在后端修掉，但只修了**响应**那一侧

`common/schema.py` 原来只给 `id` 挂了 `@field_serializer('id') -> str | int`，
所以只有 `id` 在 OpenAPI 里是 `string | number` 的联合。而**外键
（`dept_id` / `parent_id` / `role_id`…）没有那个 serializer**，声明成 `int` ——
可编码层的 `stringify_unsafe_ints` 照样把它们转成了字符串
（`utils/serializers.py` 的注释里自己写着「外键都漏了」）。
移动端打开类型推断时第一个撞上的就是这条。

现在后端补了两个 serializer（`serialize_nullable_fk` / `serialize_required_fk`），
所以**响应体**里的外键是 `string | number`（可空的再带 `| null`）。

🔴 **必须按可空性分两组写** —— pydantic 拿**返回标注**当那个字段的序列化
schema，而标注对列出的所有字段是同一份。实测两种一刀切都会错一半：

| 写法 | `type_id: int`（必填） | `dept_id: int \| None` |
|---|---|---|
| 返回 `str \| int \| None` | ❌ 被放宽成可空 | ✅ |
| 返回 `str \| int` + `when_used='unless-none'` | ✅ | ❌ 声明成不可空，而它真的会是 null |

**入参侧也修了**，但要另加一层标注 —— pydantic 的校验 schema 和序列化 schema
是两份，`field_serializer` 只动后者。`common/schema.py` 里：

```python
SnowflakeIdIn = Annotated[int, WithJsonSchema({'anyOf': [{'type': 'string'}, {'type': 'integer'}]}, mode='validation')]
```

Python 类型仍是 `int`（FastAPI 在 lax 模式下把 `"123"` 转成 int，`"abc"` 照旧被
`int_parsing` 挡住），变的只是**声明**。⚠️ `WithJsonSchema` 是**替换**那个字段的
JSON schema，所以只写 `anyOf` —— `Field(description=...)` 的描述在字段层，
不受影响（实测确认还在）。

覆盖面（`*_id` 声明成裸 `number` 的地方）：

| 位置 | 怎么修的 |
|---|---|
| 响应体 | `SchemaBase` 的两个 field_serializer（按可空性分组，见上） |
| 请求体 | 10 个 schema 文件里的字段换成 `SnowflakeIdIn` |
| 查询参数 | 全仓只有一个（`/sys/dict-datas` 的 `type_id`），同一个标注 |
| **路径参数** | **没改后端** —— 44 个 operation 把 `pk` 声明成 `number`，由客户端 `src/types.ts` 的 `LoosePath` 统一放宽 |

⚠️ 最后一行是刻意的取舍：路径参数只有 `pk` / `target_id` 两种形状、
客户端一处映射就全覆盖；去后端改 44 个签名收益一样，但 diff 大得多。
`LoosePath` 的注释里记着这件事。

### 🔴 web 端为什么还没切：三条**结构性**障碍

不是「还没抄完」。切之前必须先解掉：

| 障碍 | 位置 | 为什么不是机械改动 |
|---|---|---|
| 仪表盘拼动态路径 | `packages/platform/src/pages/dashboard/api.ts` | 字面量路径类型对运行时字符串不成立 |
| 约 20 个页面的查询串是函数拼的 | `?${qs(p)}` / `?${scopeQs(p)}` / `?${buildQuery(...)}` | 要改成 `params.query` 就得把那 20 个构造器逐个重设计（它们还顺手做了丢空值、格式化日期等事） |

实测数据：把 platform 直接指到严类型面，是 **57 个文件 / 433 个错误**
（其中根因 90 个：72 个显式泛型 + 18 个模板字符串路径，其余是级联）。

⚠️ 这张表原来有第三条「列表页引擎的路径是运行时配置」—— platform 的
`_shared` 下曾经有个只读列表工厂，按 `cfg.endpoint`（运行时字符串）取数。
那个文件**零调用方**（写好之后就没接过），已经删了
（见 [pages 分册](../platform/src/pages/AGENTS.md)）。
**休眠代码的代价就是这个**：它让一次架构评估多报了一条根本不存在的障碍。

### 两处不能直接写的类型（都踩过）

- **`Paths[P][M]` 写不了。** `paths` 是**接口**、没有索引签名，TS 无法为泛型
  `Paths` 证明 `M extends keyof Paths[P]`。openapi-fetch 自己的 `ClientMethod`
  把 Paths 约束成 `Record<string, Record<HttpMethod, {}>>` —— **`paths` 不满足
  那个约束**（`Index signature for type 'string' is missing`），它们的 `.d.ts`
  只是被 `skipLibCheck: true` 盖住了。用条件类型把双重索引拆开
- **名字数组不能加 `as const`**（这条在 mobile 分册，`useCSSVariable` 同一个物种）

## 🔴 查询参数名是严的，**路径参数完全不检查** —— 实测

同一次调用里：

| | 类型检查 | 实测 |
|---|---|---|
| `params.query` 的**参数名** | **严** | 写成 `usernamee` → `TS2561`，还提示「Did you mean 'username'」 |
| `params.path` 的**值** | **不检查** | schema 里写着 `pk: number`，传 `string` / `string \| number` **零报错** |

所以雪花 ID 当路径参数时**编译器两个方向都不管**：

- 好的一面：不会被 `pk: number` 那个声明逼着去写 `Number(id)`
- 🔴 坏的一面：**也没人挡着你写 `Number(id)`** —— 写了照样编译通过，
  然后静默打开/删掉另一条记录（硬纪律 6：`2049629108245233664` →
  `...233700`，连续几个 ID 还会塌成同一个值）

⚠️ `pk: number` 这个声明本身是后端**入参侧**的标注问题（pydantic 的校验 schema
和序列化 schema 是两份，`field_serializer` 只动后者 —— 所以**响应**里的 `id` /
外键已经是 `string | number` 了，而路径/请求体那一侧仍然声明 `integer`）。
**别在前端覆盖类型**绕过它 —— 那要维护一份「哪些声明是错的」名单，
真正的修法在后端入参侧加标注。

探针长这样（三行都在同一个文件里，只有第三行报错）：

```ts
api.GET('/api/v1/sys/users/{pk}', { params: { path: { pk: idStr } } })       // ✅ 0 错误
api.GET('/api/v1/sys/users/{pk}', { params: { path: { pk: idUnion } } })     // ✅ 0 错误
api.GET('/api/v1/sys/users', { params: { query: { usernamee: 'x' } } })     // ❌ TS2561
```

## 🔴 判断错误必须同时看 `httpStatus` 和 `bizCode`

`_get_exception_code` 会把**非法 HTTP 状态码降级成 400**。所以
`CAPTCHA_ERROR = (40001, ...)` 到客户端是 `HTTP 400` + `{code: 40001}`。
只看其一会漏 —— `ApiError` 两个都存着。

`httpStatus === 0`（`NETWORK_STATUS`）表示**网络层就没走通**（连不上 / DNS / TLS），
不是服务端返回的错误，用 `error.isNetwork` 判。

## 生成的类型：`pnpm --filter @admin/api gen:api`

`src/schema.d.ts` 是 `openapi-typescript` 从后端 OpenAPI 生成的，**不要手改**。

🔴 **不需要起服务。** 这条原来是
`openapi-typescript http://127.0.0.1:8000/openapi -o src/schema.d.ts`，两个毛病：
**端口是错的**（后端 dev 在 **8088**，`:8000` 上什么都没有 —— 谁跑都只会拿到
`ECONNREFUSED`，而报错完全不提端口写错了），以及它要求先起服务，
而生成契约和运行时无关（`app.openapi()` 不碰数据库）。
现在 `scripts/gen.mjs` 直接 import FastAPI 的 app 拿 spec。

⚠️ 那个脚本让 python 把 JSON **写进文件**而不是走管道 —— 后端启动期会往
stdout 打几行插件探测日志，混在一起解析会失败，而失败信息看不出是日志的锅。
它原来在 `packages/platform/src/api-client/` 下，搬过来是为了让 `apps/mobile`
也能用同一份 —— 移动端现在还有一份**手抄**的 DTO（`src/lib/contract.ts`），
那是个待还的债：手抄的字段对不上时不会报错，只会在界面上空一格。

## 搬家留下的一层 re-export

`packages/platform/src/api-client/errors.ts` 现在只是
`export { ApiError, isEnvelope } from '@admin/api'` ——
`ApiError` 有十几处调用点（`pages/**`、`ui/components/query-error.tsx`…），
没必要为一次搬家全改一遍 import。**新代码直接从 `@admin/api` 取。**
