import { ApiError, NETWORK_STATUS, resolveEnvelope } from '@admin/api-contract'
import { currentLanguage, t } from '@admin/i18n'

import { serverStore } from '@/lib/server'
import { tokenStore } from '@/lib/token-store'

/**
 * 移动端的 API 客户端 —— **只有传输层是自己的**。
 *
 * 成败语义、错误类型、生成的接口类型、分页结构全在 `@admin/api-contract`，
 * **和 web 端共用一份**（见那个包的 index 注释里那张对照表）。
 *
 * 不复用 `packages/platform/src/api-client` 的原因是传输层真的不一样：
 * 那份走 `import.meta.env` / `sessionStorage` / `credentials: 'include'`，
 * 而且它属于 `platform`（web 形状：TanStack Router、react-dom、zustand、
 * socket.io），硬接进来会把那一堆拖进 RN 包。
 *
 * ⚠️ 这份文件曾经**自己复制了一份** `ApiError` / `isEnvelope` / 拆包逻辑，
 * 结果就是「HTTP 200 + code 400 被当成成功」那个坑两端各有一份 ——
 * 现在判定收在共享包里，不要再往这里抄。
 */

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
      const res = await fetch(`${serverStore.current()}/api/v1/auth/refresh`, { method: 'POST' })
      if (!res.ok) return false
      const body = (await res.json()) as { data?: { access_token?: string } }
      const next = body?.data?.access_token
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
    res = await fetch(`${serverStore.current()}${path}`, {
      method,
      headers: {
        // 🔴 后端有 i18n 中间件按 `Accept-Language` 切响应 `msg`
        // （`backend/common/i18n.py`）。**必须跟界面语言同步** ——
        // 之前这里写死 `'zh-CN'`，切成英文界面之后接口报错还是中文，
        // 看起来像坏了。另外不发这个头的话，未映射的语言会让**所有** msg
        // 变成「当前语言包未初始化或不存在」。
        'Accept-Language': currentLanguage(),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    // 网络层失败（连不上 / DNS / TLS）在 RN 里只有一句笼统的 `Network request failed`，
    // 不提是哪一种。把地址带上，否则排查时完全没有线索。
    throw new ApiError(NETWORK_STATUS, NETWORK_STATUS, t('连不上服务器（{{base}}）：{{reason}}', { base: serverStore.current(), reason: String(err) }))
  }

  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    // 不是 JSON（反代的 HTML 错误页之类）
  }

  /*
   * 🔴 成败判定走共享的 `resolveEnvelope` —— **不要只看 `res.ok`**。
   * `response_base.fail()` 返回的是 HTTP 200 + `code: 400`，而
   * `/me/nickname`、`/me/avatar`、`/me/timezone` 在「写了 0 行」时走的正是那条路。
   * 只看 HTTP 状态的话，被拒的写入会被读成成功：编辑资料照常退回、
   * 时区照常打勾，一个错都不报。实测踩过。
   */
  const outcome = resolveEnvelope<T>(res, parsed)

  if (!outcome.ok) {
    if (outcome.error.isUnauthorized && retry) {
      const ok = await refreshToken()
      if (ok) return send<T>(method, path, body, false)
      await tokenStore.clear()
      onSessionExpired?.()
    }
    throw outcome.error
  }

  return outcome.data
}

export const api = {
  GET: <T>(path: string) => send<T>('GET', path),
  POST: <T>(path: string, body?: unknown) => send<T>('POST', path, body),
  PUT: <T>(path: string, body?: unknown) => send<T>('PUT', path, body),
  DELETE: <T>(path: string, body?: unknown) => send<T>('DELETE', path, body),
}
