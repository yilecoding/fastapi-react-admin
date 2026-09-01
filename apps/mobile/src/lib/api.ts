import { API_BASE } from '@/lib/config'
import { tokenStore } from '@/lib/token-store'

/**
 * 移动端自己的一份 API 客户端。
 *
 * **为什么不复用 `packages/platform/src/api-client`**：那一份是 web 形状的 ——
 * 走 `import.meta.env`、`sessionStorage`、`credentials: 'include'`，
 * 而且它属于 `platform`，而依赖箭头是 `i18n ← ui ← platform ← apps/web`，
 * `apps/mobile` 是 `apps/web` 的兄弟，不在那条箭头上。硬接进来会把
 * react-dom / TanStack Router 一起拖进 RN 包。
 *
 * **契约仍然是同一份**（FBA 的 `{code, msg, data}` 包封 + 401 刷新），
 * 所以这份文件刻意逐条对齐 `client.ts` 的行为，改后端契约时两边一起改。
 */

/**
 * FBA 的错误契约有个陷阱：`exception_handler.py` 会把**非法 HTTP 状态码降级成 400**，
 * 所以像 `CAPTCHA_ERROR = (40001, ...)` 这样的业务码，客户端收到的是
 * `HTTP 400` + body `{code: 40001}`。判断错误必须同时看两个，只看其一会漏。
 */
export class ApiError extends Error {
  readonly httpStatus: number
  readonly bizCode: number

  constructor(httpStatus: number, bizCode: number, msg: string) {
    super(msg)
    this.name = 'ApiError'
    this.httpStatus = httpStatus
    this.bizCode = bizCode
  }

  get isUnauthorized() {
    return this.httpStatus === 401
  }

  get isForbidden() {
    return this.httpStatus === 403
  }

  get isRateLimited() {
    return this.httpStatus === 429
  }
}

type Envelope = { code: number; msg: string; data?: unknown }

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === 'object' && v !== null && 'code' in v && 'msg' in v
}

/** 会话失效时的回调（由 session 层注入：清状态 + 回登录屏） */
let onSessionExpired: (() => void) | null = null
export function setSessionExpiredHandler(fn: (() => void) | null) {
  onSessionExpired = fn
}

// ─── 401 单飞刷新 ──────────────────────────────────────────────────────────────
// 并发请求同时收到 401 时只允许一次 /auth/refresh 在途，其余排队等它的结果。
// 没有这层，token 过期瞬间会打出 N 个 refresh，后端会话表和 Redis 都会被打乱。
let refreshing: Promise<boolean> | null = null

async function refreshToken(): Promise<boolean> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      // refresh token 在 httpOnly cookie 里，RN 的 cookie jar 自动带上 ——
      // 这里**刻意不设任何头**，实测就是这么刷成功的
      const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, { method: 'POST' })
      if (!res.ok) return false
      const body = (await res.json()) as Envelope
      const next = (body?.data as { access_token?: string } | undefined)?.access_token
      if (!next) return false
      await tokenStore.set(next)
      return true
    } catch {
      return false
    } finally {
      // 交给微任务队列，确保同批次的等待者都拿到同一个结果后再复位
      queueMicrotask(() => {
        refreshing = null
      })
    }
  })()
  return refreshing
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'

async function send<T>(method: Method, path: string, body?: unknown, retry = true): Promise<T> {
  const token = tokenStore.get()
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        // 后端有 i18n 中间件按 Accept-Language 切响应 msg。不发这个头的话
        // 未映射的语言会让**所有** msg 变成「当前语言包未初始化或不存在」。
        'Accept-Language': 'zh-CN',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    // 网络层失败（连不上 / DNS / TLS）在 RN 里只有一句笼统的 `Network request failed`，
    // 不提是哪一种。把地址带上，否则排查时完全没有线索。
    throw new ApiError(0, 0, `连不上服务器（${API_BASE}）：${String(err)}`)
  }

  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    // 不是 JSON（反代的 HTML 错误页之类）
  }

  if (!res.ok) {
    if (res.status === 401 && retry) {
      const ok = await refreshToken()
      if (ok) return send<T>(method, path, body, false)
      await tokenStore.clear()
      onSessionExpired?.()
    }
    const bizCode = isEnvelope(parsed) ? parsed.code : res.status
    const msg = isEnvelope(parsed) ? parsed.msg : res.statusText || `HTTP ${res.status}`
    throw new ApiError(res.status, bizCode, msg)
  }

  // 拆包：业务代码不该看见 code/msg
  return (isEnvelope(parsed) ? (parsed.data as T) : (parsed as T))
}

export const api = {
  GET: <T>(path: string) => send<T>('GET', path),
  POST: <T>(path: string, body?: unknown) => send<T>('POST', path, body),
  PUT: <T>(path: string, body?: unknown) => send<T>('PUT', path, body),
  DELETE: <T>(path: string, body?: unknown) => send<T>('DELETE', path, body),
}
