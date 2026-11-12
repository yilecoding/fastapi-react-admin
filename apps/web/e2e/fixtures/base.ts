import { test as base, expect, request } from "@playwright/test"

import type { APIRequestContext, Page } from "@playwright/test"

export const API_BASE = process.env.E2E_API_BASE ?? "http://127.0.0.1:8001"

export async function loginToken(ctx: APIRequestContext, username = "admin", password = "123456") {
  const res = await ctx.post("/api/v1/auth/login/swagger", {
    params: { username, password },
  })
  if (!res.ok()) throw new Error(`登录失败（HTTP ${res.status()}）：${await res.text()}`)
  const body = (await res.json()) as { access_token: string; session_uuid: string }
  return { token: body.access_token, sessionUuid: body.session_uuid }
}

/**
 * 走**真实** `/auth/login` 建一个会话，拿回浏览器要用的 refresh cookie（#138）。
 *
 * access token 只在页面内存里，页面加载时用 refresh cookie 静默恢复 —— 所以给页面「登录态」
 * 就是往它的 context 里塞这个 cookie。swagger 口不下发 cookie，这里用不了它。
 * 验证码由 `global-setup.ts` 在 fba_test 里关掉了；E2E 环境不限流（`.env.e2e`）。
 */
export async function loginSession(username = "admin", password = "123456") {
  const ctx = await request.newContext({ baseURL: API_BASE })
  try {
    const res = await ctx.post("/api/v1/auth/login", { data: { username, password } })
    const body = (await res.json().catch(() => null)) as {
      code?: number
      data?: { access_token: string; session_uuid: string }
    } | null
    if (!res.ok() || body?.code !== 200 || !body.data) {
      throw new Error(`登录失败（HTTP ${res.status()}）：${JSON.stringify(body)}`)
    }
    const { cookies } = await ctx.storageState()
    const userId = await fetchMeId(ctx, body.data.access_token)
    return { cookies, token: body.data.access_token, sessionUuid: body.data.session_uuid, userId }
  } finally {
    await ctx.dispose()
  }
}

/** 当前登录用户的 id（雪花 ID 字符串）。踢会话的用例（session.spec.ts）要拿它拼路径 */
async function fetchMeId(ctx: APIRequestContext, token: string): Promise<string> {
  const res = await ctx.get("/api/v1/sys/users/me", { headers: { Authorization: `Bearer ${token}` } })
  const body = (await res.json()) as { data?: { id?: string } }
  if (!body.data?.id) throw new Error(`拿不到当前用户 id（HTTP ${res.status()}）：${JSON.stringify(body)}`)
  return body.data.id
}

export type ApiClient = {
  get: (apiPath: string) => Promise<unknown>
  post: (apiPath: string, data?: unknown) => Promise<unknown>
  put: (apiPath: string, data?: unknown) => Promise<unknown>
  del: (apiPath: string, data?: unknown) => Promise<unknown>
}

/**
 * SQL Server 把并发事务里的一个判成死锁牺牲者（1205），回的是 500 + 原文里的 `(1205)`。
 *
 * 🔴 CI 的 E2E 跑在 SQL Server 上（RCSI 关着），几个 spec 并行在 beforeAll / afterAll 里建、删用户时会撞上：
 * PR #191 第一次 CI，`notice-phase2.spec.ts` 建账号的 `POST /sys/users` 和别的 spec 收尾的
 * `DELETE /sys/users/{pk}`（删 `sys_user_role`）互锁，前者被选为牺牲者 → beforeAll 抛 → 整组 8 条跳过。
 * 本地 E2E 跑的是 PostgreSQL，碰不到。报错原文就写着「Rerun the transaction」—— 那是这类错误的正解
 * （牺牲者的整个事务已经回滚，重发 POST 不会多建一条），所以造数据的接口调用在这里重试；
 * 页面上的请求不经过这里，照旧原样暴露
 */
const DEADLOCK_RETRIES = 3

function isDeadlockVictim(status: number, body: { msg?: string } | null): boolean {
  return status === 500 && typeof body?.msg === "string" && body.msg.includes("(1205)")
}

function makeClient(ctx: APIRequestContext, token: string): ApiClient {
  const headers = { Authorization: `Bearer ${token}` }

  async function unwrap(send: () => Promise<Awaited<ReturnType<APIRequestContext["get"]>>>) {
    for (let attempt = 0; ; attempt++) {
      const res = await send()
      const body = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null
      if (attempt < DEADLOCK_RETRIES && isDeadlockVictim(res.status(), body)) {
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
        continue
      }
      if (!res.ok() || (body && typeof body.code === "number" && body.code !== 200)) {
        throw new Error(`接口调用失败 [${res.status()}] ${res.url()}：${JSON.stringify(body)}`)
      }
      return body?.data
    }
  }

  return {
    get: (p) => unwrap(() => ctx.get(`${API_BASE}${p}`, { headers })),
    post: (p, data) => unwrap(() => ctx.post(`${API_BASE}${p}`, { headers, data })),
    put: (p, data) => unwrap(() => ctx.put(`${API_BASE}${p}`, { headers, data })),
    del: (p, data) => unwrap(() => ctx.delete(`${API_BASE}${p}`, { headers, data })),
  }
}

/**
 * 脱离 fixture 生命周期的 admin 接口客户端。
 *
 * `api` fixture 是**每条测试**一份，`beforeAll` / `afterAll` 里拿不到它 ——
 * 而「一次建好一整套账号、跑完一批测试再拆掉」这种前置数据（data-permission.spec.ts）
 * 只能建在 beforeAll 里，否则每条测试重建一遍 20 多个账号，慢到没法用。
 */
export async function createApiClient(): Promise<{ api: ApiClient; dispose: () => Promise<void> }> {
  const ctx = await request.newContext({ baseURL: API_BASE })
  const { token } = await loginToken(ctx)
  return { api: makeClient(ctx, token), dispose: () => ctx.dispose() }
}

/**
 * 把**指定账号**的登录态注入到一个干净的 page 上。
 *
 * `authedPage` 写死了 admin；测数据权限要的正是「换个账号看见的不一样」，
 * 所以需要一个能指定用户名的版本。注入方式同 `authedPage`（往 context 里塞 refresh cookie）。
 */
export async function loginPageAs(page: Page, username: string, password: string): Promise<void> {
  const session = await loginSession(username, password)
  await page.context().addCookies(session.cookies)
}

export const test = base.extend<{ authedPage: Page; api: ApiClient }>({
  // 直接打接口的客户端 —— 用来在测试里造/清前置数据，绕开不相关的 UI 步骤。
  // 见 CLAUDE.md「E2E 测试」里「造前置数据不用走 UI」那条。
  api: async ({}, use) => {
    const ctx = await request.newContext({ baseURL: API_BASE })
    const { token } = await loginToken(ctx)
    await use(makeClient(ctx, token))
    await ctx.dispose()
  },

  // 已登录的页面。
  //
  // access token 只在页面内存里（#138），页面加载时用 refresh cookie 静默恢复 ——
  // 所以这里只往 context 里塞一个真实登录拿到的 cookie，和用户在浏览器里登录过一次之后的状态一样。
  // ⚠️ #138 之前 token 在 sessionStorage、守卫只认它，这里只能 `addInitScript` 往每个页面里塞 token
  //（Playwright 的 `storageState` 不存 sessionStorage）；现在 cookie 就是全部登录态。
  authedPage: async ({ page }, use) => {
    const session = await loginSession()
    await page.context().addCookies(session.cookies)

    await use(page)
  },
})

export { expect }
