/**
 * 后端契约 —— **两端共用的那一份**。
 *
 * 结构和 `packages/i18n` 同一个物种：它是**新的最底层之一**，
 * **不依赖任何 workspace 包**，也不依赖任何运行时（没有 DOM、没有 RN）。
 *
 * 依赖方向：**`api` / `i18n` ← `ui` ← `platform` ← `apps/web`**，
 * 而 `apps/mobile` 直接依赖这两个底层包（它是 `apps/web` 的兄弟，
 * 不在 `platform` 那条链上 —— platform 是 web 形状的：TanStack Router、
 * react-dom、zustand、socket.io）。
 *
 * ── 契约和客户端**都**在这里 ──
 *
 * 一开始只共享契约、两端各写一份传输层，代价是实测出来的：
 * 「HTTP 200 + `code: 400` 被当成成功」那个坑**两端各有一份**
 * （见 `envelope.ts`），改一边不会修另一边。
 *
 * 现在传输层也收进来了（`client.ts` 的 `createApiClient`），平台差异全部
 * 走**注入**，包里一个 `if (platform)` 都没有：
 *
 * |            | web                          | mobile                       |
 * |------------|------------------------------|------------------------------|
 * | base URL   | `import.meta.env`（编译期）  | `serverStore`（运行时可改）  |
 * | token      | `sessionStorage`             | `expo-secure-store` + 内存   |
 * | 语言       | app 层 `setApiLanguage()`    | `currentLanguage()` 直接读   |
 * | refresh    | `credentials: 'include'`     | RN 自带 cookie jar           |
 * | 各自加的   | multipart 上传 / 字节下载    | 网络错误文案 i18n            |
 *
 * 共享的是：信封成败语义、`ApiError`、401 单飞刷新、`Accept-Language`、
 * 生成的接口类型、分页结构。
 *
 * ⚠️ 本包**仍然零 workspace 依赖** —— 所以 i18n 是注入的（`getLanguage`），
 * 不是 import 的。
 */
export { ApiError, isEnvelope, type Envelope } from './errors'
export { NETWORK_STATUS, resolveEnvelope, type EnvelopeResult } from './envelope'
export type { PageData } from './page'
export { createApiClient, type ApiClient, type ApiClientConfig, type Method } from './client'
