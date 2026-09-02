/**
 * 后端契约 —— **两端共用的那一份**。
 *
 * 结构和 `packages/i18n` 同一个物种：它是**新的最底层之一**，
 * **不依赖任何 workspace 包**，也不依赖任何运行时（没有 DOM、没有 RN）。
 *
 * 依赖方向：**`api-contract` / `i18n` ← `ui` ← `platform` ← `apps/web`**，
 * 而 `apps/mobile` 直接依赖这两个底层包（它是 `apps/web` 的兄弟，
 * 不在 `platform` 那条链上 —— platform 是 web 形状的：TanStack Router、
 * react-dom、zustand、socket.io）。
 *
 * ── 为什么只共享「契约」，不共享「客户端」 ──
 *
 * 传输层两端确实不一样，硬合并只会做出一个到处 `if (platform)` 的东西：
 *
 * |            | web                        | mobile                     |
 * |------------|----------------------------|----------------------------|
 * | 传输       | `openapi-fetch`            | 裸 `fetch`                 |
 * | token      | `sessionStorage`           | `expo-secure-store`        |
 * | base URL   | `import.meta.env`（编译期）| 运行时可改（设置屏）       |
 * | refresh    | `credentials: 'include'`   | RN 自带 cookie jar         |
 * | 额外能力   | multipart 上传 / ArrayBuffer 下载 | —                   |
 *
 * 而**共享的是**：信封的成败语义、错误类型、生成的接口类型、分页结构。
 * 那几样各写一份的代价已经付过一次了 —— `resolveEnvelope` 那段注释里那个
 * 「HTTP 200 + code 400 被当成成功」的坑，两端都有。
 */
export { ApiError, isEnvelope, type Envelope } from './errors'
export { NETWORK_STATUS, resolveEnvelope, type EnvelopeResult } from './envelope'
export type { PageData } from './page'
