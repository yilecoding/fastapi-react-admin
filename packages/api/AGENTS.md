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

**这条踩过一次，而且两端各有一份。** 客户端只看 `!res.ok` 的话，所有
「写了 0 行 → `fail()`」的响应都被读成成功：

| 接口 | handler 里的形状 |
|---|---|
| `PUT /sys/users/me/nickname` | `if count > 0: success() else: fail()` |
| `PUT /sys/users/me/avatar` | 同上 |
| `PUT /sys/users/me/timezone` | 同上 |

界面上表现为「保存成功、页面退回、值没变」，**一个错都不报**。

所以这个判定收进 `resolveEnvelope()`，**两端共用**：

```ts
const outcome = resolveEnvelope<T>(res, parsedBody)
if (!outcome.ok) throw outcome.error   // 401 由调用方自己决定怎么处理
return outcome.data
```

⚠️ `resolveEnvelope` **刻意不处理 401 刷新** —— 那一步两端机制不同
（web 靠 `credentials: 'include'`，RN 靠自带的 cookie jar），而且要访问各自的
token 存储。调用方拿 `error.isUnauthorized` 自己判。

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

## 🔴 判断错误必须同时看 `httpStatus` 和 `bizCode`

`_get_exception_code` 会把**非法 HTTP 状态码降级成 400**。所以
`CAPTCHA_ERROR = (40001, ...)` 到客户端是 `HTTP 400` + `{code: 40001}`。
只看其一会漏 —— `ApiError` 两个都存着。

`httpStatus === 0`（`NETWORK_STATUS`）表示**网络层就没走通**（连不上 / DNS / TLS），
不是服务端返回的错误，用 `error.isNetwork` 判。

## 生成的类型：`pnpm --filter @admin/api gen:api`

`src/schema.d.ts` 是 `openapi-typescript` 从后端 OpenAPI 生成的，**不要手改**。
它原来在 `packages/platform/src/api-client/` 下，搬过来是为了让 `apps/mobile`
也能用同一份 —— 移动端现在还有一份**手抄**的 DTO（`src/lib/contract.ts`），
那是个待还的债：手抄的字段对不上时不会报错，只会在界面上空一格。

## 搬家留下的一层 re-export

`packages/platform/src/api-client/errors.ts` 现在只是
`export { ApiError, isEnvelope } from '@admin/api'` ——
`ApiError` 有十几处调用点（`pages/**`、`ui/components/query-error.tsx`…），
没必要为一次搬家全改一遍 import。**新代码直接从 `@admin/api` 取。**
