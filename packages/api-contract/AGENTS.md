# packages/api-contract —— 后端契约，两端共用的那一份

> 这份文件是根 `CLAUDE.md` 的**模块分册**，Claude Code 读到本目录下的文件时才加载它。

**最底层之一**（和 `packages/i18n` 同一个物种）：**不依赖任何 workspace 包**，
也不依赖任何运行时 —— 没有 DOM、没有 React Native、没有 React。

依赖方向：**`i18n` / `api-contract` ← `ui` ← `platform` ← `apps/web`**，
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

## 为什么只共享「契约」，不共享「客户端」

传输层两端确实不一样，硬合并只会做出一个到处 `if (platform)` 的东西：

| | web | mobile |
|---|---|---|
| 传输 | `openapi-fetch` | 裸 `fetch` |
| token | `sessionStorage` | `expo-secure-store` |
| base URL | `import.meta.env`（编译期） | 运行时可改（设置屏） |
| refresh | `credentials: 'include'` | RN 自带 cookie jar |
| 额外能力 | multipart 上传 / ArrayBuffer 下载 | — |

**共享的是**：信封的成败语义、`ApiError`、生成的接口类型、`PageData`。

## 🔴 判断错误必须同时看 `httpStatus` 和 `bizCode`

`_get_exception_code` 会把**非法 HTTP 状态码降级成 400**。所以
`CAPTCHA_ERROR = (40001, ...)` 到客户端是 `HTTP 400` + `{code: 40001}`。
只看其一会漏 —— `ApiError` 两个都存着。

`httpStatus === 0`（`NETWORK_STATUS`）表示**网络层就没走通**（连不上 / DNS / TLS），
不是服务端返回的错误，用 `error.isNetwork` 判。

## 生成的类型：`pnpm --filter @admin/api-contract gen:api`

`src/schema.d.ts` 是 `openapi-typescript` 从后端 OpenAPI 生成的，**不要手改**。
它原来在 `packages/platform/src/api-client/` 下，搬过来是为了让 `apps/mobile`
也能用同一份 —— 移动端现在还有一份**手抄**的 DTO（`src/lib/contract.ts`），
那是个待还的债：手抄的字段对不上时不会报错，只会在界面上空一格。

## 搬家留下的一层 re-export

`packages/platform/src/api-client/errors.ts` 现在只是
`export { ApiError, isEnvelope } from '@admin/api-contract'` ——
`ApiError` 有十几处调用点（`pages/**`、`ui/components/query-error.tsx`…），
没必要为一次搬家全改一遍 import。**新代码直接从 `@admin/api-contract` 取。**
