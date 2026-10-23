import { afterEach, describe, expect, it } from 'vitest'

import { ApiError, createApiClient, type ApiClientConfig, type SessionEnd } from '@admin/api'

/**
 * `@admin/api` 的 401 刷新（#138）。这一层没有 E2E 能稳定造出来的场景（刷新恰好撞上 502、
 * 三个请求同时 401），所以用一个桩 fetch 测。
 *
 * ⚠️ 桩要在 `createApiClient` **之前**装上：openapi-fetch 在建客户端时就把 `globalThis.fetch`
 * 快照走了（`packages/api` 分册「怎么验」那条）—— 建完再换是无效的，测试会先假绿一次
 */
const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type Seen = { url: string; headers: Record<string, string> }

function setup(
  handle: (url: string, headers: Record<string, string>) => Response,
  extra: Partial<ApiClientConfig> = {},
) {
  const seen: Seen[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null
    const url = req ? req.url : String(input)
    const headers = Object.fromEntries(new Headers(req ? req.headers : init?.headers).entries())
    seen.push({ url, headers })
    return handle(url, headers)
  }) as typeof fetch

  let token: string | null = 'old'
  const ended: SessionEnd[] = []
  const client = createApiClient<Record<string, never>>({
    getBaseUrl: () => 'http://api',
    getToken: () => token,
    setToken: (t) => {
      token = t
    },
    clearToken: () => {
      token = null
    },
    getLanguage: () => 'zh-CN',
    onSessionExpired: (end) => ended.push(end),
    ...extra,
  })
  const loose = client as unknown as { GET: (p: string) => Promise<unknown> }
  return { client, get: (p: string) => loose.GET(p), seen, ended, token: () => token }
}

const isRefresh = (url: string) => url.endsWith('/api/v1/auth/refresh')
const ok = (data: unknown) => json(200, { code: 200, msg: 'ok', data })
const unauthorized = (data: unknown = null) => json(401, { code: 401, msg: 'Token 已过期', data })

describe('401 之后的刷新分三种结果', () => {
  it('刷新撞上 502：不清登录态、不跳登录页，把 502 抛给这次请求', async () => {
    const t = setup((url) => (isRefresh(url) ? json(502, { code: 502, msg: 'Bad Gateway', data: null }) : unauthorized()))
    const err = await t.get('/api/v1/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).httpStatus).toBe(502)
    expect(t.ended).toEqual([])
    expect(t.token()).toBe('old')
  })

  it('刷新被拒（401 带原因码）：清登录态，并把原因交给收尾回调', async () => {
    const t = setup((url) =>
      isRefresh(url)
        ? json(401, { code: 401, msg: '你已被管理员强制下线，请重新登录', data: { reason: 'kicked' } })
        : unauthorized(),
    )
    await expect(t.get('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
    expect(t.ended).toEqual([{ reason: 'kicked', message: '你已被管理员强制下线，请重新登录' }])
    expect(t.token()).toBeNull()
  })

  it('网络不通：同样只是这一次没刷成', async () => {
    const t = setup((url) => {
      if (isRefresh(url)) throw new TypeError('fetch failed')
      return unauthorized()
    })
    const err = await t.get('/api/v1/x').catch((e: unknown) => e)
    expect((err as ApiError).isNetwork).toBe(true)
    expect(t.ended).toEqual([])
    expect(t.token()).toBe('old')
  })

  it('三个请求同时 401：只刷新一次，三个都拿新 token 重放成功', async () => {
    const t = setup((url, headers) => {
      if (isRefresh(url)) return ok({ access_token: 'new' })
      return headers.authorization === 'Bearer new' ? ok(1) : unauthorized()
    })
    await expect(Promise.all([t.get('/api/v1/a'), t.get('/api/v1/b'), t.get('/api/v1/c')])).resolves.toEqual([1, 1, 1])
    expect(t.seen.filter((s) => isRefresh(s.url))).toHaveLength(1)
  })
})

describe('会话已经在本地结束之后', () => {
  it('没带 token 的请求撞上 401：不刷新、不再收尾一次（不然会把「因为什么被登出」覆盖掉）', async () => {
    const t = setup((url) => (isRefresh(url) ? unauthorized() : unauthorized()))
    t.client.endSession({ reason: 'logout', message: null })
    await expect(t.get('/api/v1/x')).rejects.toBeInstanceOf(ApiError)
    expect(t.seen.some((s) => isRefresh(s.url))).toBe(false)
    expect(t.ended).toEqual([{ reason: 'logout', message: null }])
  })
})

describe('注入点', () => {
  it('每个请求都带上用户多少秒没操作（X-Client-Idle），刷新请求不带 Authorization', async () => {
    const t = setup(
      (url, headers) => {
        if (isRefresh(url)) return ok({ access_token: 'new' })
        return headers.authorization === 'Bearer new' ? ok(1) : unauthorized()
      },
      { getClientIdle: () => 42.7 },
    )
    await t.get('/api/v1/x')
    const business = t.seen.filter((s) => !isRefresh(s.url))
    expect(business.every((s) => s.headers['x-client-idle'] === '42')).toBe(true)
    expect(t.seen.find((s) => isRefresh(s.url))?.headers.authorization).toBeUndefined()
  })

  it('注入了 refresh（桌面端走主进程）就不发 cookie 刷新', async () => {
    const t = setup((url, headers) => (headers.authorization === 'Bearer desk' ? ok(1) : unauthorized()), {
      refresh: async () => ({ kind: 'ok', token: 'desk' }),
    })
    await expect(t.get('/api/v1/x')).resolves.toBe(1)
    expect(t.seen.some((s) => isRefresh(s.url))).toBe(false)
  })

  it('restoreSession：手里没有 token 时静默换一枚（页面加载 / 新标签页）', async () => {
    const t = setup((url) => (isRefresh(url) ? ok({ access_token: 'restored' }) : unauthorized()))
    t.client.endSession()
    t.ended.length = 0
    await expect(t.client.restoreSession()).resolves.toEqual({ kind: 'ok', token: 'restored' })
    expect(t.token()).toBe('restored')
    // 恢复失败不走收尾回调 —— 去不去登录页由守卫决定
    expect(t.ended).toEqual([])
  })
})
