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

/** 当前登录用户的 id（雪花 ID 字符串）。`seedTourSeen` 要按人写「看过了」 */
async function fetchMeId(ctx: APIRequestContext, token: string): Promise<string> {
  const res = await ctx.get("/api/v1/sys/users/me", { headers: { Authorization: `Bearer ${token}` } })
  const body = (await res.json()) as { data?: { id?: string } }
  if (!body.data?.id) throw new Error(`拿不到当前用户 id（HTTP ${res.status()}）：${JSON.stringify(body)}`)
  return body.data.id
}

/**
 * 把外壳导览标成「这个人已经看过」。
 *
 * 🔴 不种这一条，**每一条**落到 /dashboard 的用例都会先弹出导览遮罩，把页面上所有点击
 * 都挡住（driver.js 给 body 之外的一切 `pointer-events: none`）—— 整套用例一起红，
 * 而报错是各自的「元素不可点」，没有一条会指向导览。
 *
 * 写的是 `shell/preferences.ts` 的持久化格式（zustand persist：`{ state, version }`），
 * 和真实用户看完一遍留下的记录一样；**合并**进已有的 `admin:prefs` 而不是覆盖 ——
 * 用例自己改过的偏好（关掉多页签之类）在 reload 后要还在。
 * 版本号写 999：`tourSeen()` 判的是 `已看版本 >= 当前版本`，不用跟着 SHELL_TOUR.version 改。
 * 导览自己的用例（tour.spec.ts）用 `loginPageAs(…, { tourSeen: false })` 绕开它。
 */
export async function seedTourSeen(page: Page, userId: string): Promise<void> {
  await page.addInitScript((uid) => {
    const KEY = "admin:prefs"
    let data: { state?: Record<string, unknown>; version?: number } = {}
    try {
      data = JSON.parse(localStorage.getItem(KEY) ?? "{}") as typeof data
    } catch {
      data = {}
    }
    const state = data.state ?? {}
    const seen = { ...((state.toursSeen as Record<string, number> | undefined) ?? {}), [`${uid}:shell`]: 999 }
    localStorage.setItem(KEY, JSON.stringify({ version: data.version ?? 0, state: { ...state, toursSeen: seen } }))
  }, userId)
}

export type ApiClient = {
  get: (apiPath: string) => Promise<unknown>
  post: (apiPath: string, data?: unknown) => Promise<unknown>
  put: (apiPath: string, data?: unknown) => Promise<unknown>
  del: (apiPath: string, data?: unknown) => Promise<unknown>
}

function makeClient(ctx: APIRequestContext, token: string): ApiClient {
  const headers = { Authorization: `Bearer ${token}` }

  async function unwrap(resPromise: Promise<Awaited<ReturnType<APIRequestContext["get"]>>>) {
    const res = await resPromise
    const body = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null
    if (!res.ok() || (body && typeof body.code === "number" && body.code !== 200)) {
      throw new Error(`接口调用失败 [${res.status()}] ${res.url()}：${JSON.stringify(body)}`)
    }
    return body?.data
  }

  return {
    get: (p) => unwrap(ctx.get(`${API_BASE}${p}`, { headers })),
    post: (p, data) => unwrap(ctx.post(`${API_BASE}${p}`, { headers, data })),
    put: (p, data) => unwrap(ctx.put(`${API_BASE}${p}`, { headers, data })),
    del: (p, data) => unwrap(ctx.delete(`${API_BASE}${p}`, { headers, data })),
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
export async function loginPageAs(
  page: Page,
  username: string,
  password: string,
  opts: { tourSeen?: boolean } = {}
): Promise<void> {
  const session = await loginSession(username, password)
  await page.context().addCookies(session.cookies)
  // 默认把外壳导览标成已看过，理由见 seedTourSeen；只有导览自己的用例关掉它
  if (opts.tourSeen !== false) await seedTourSeen(page, session.userId)
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
    // 外壳导览标成已看过，否则首屏就是一层遮罩 —— 见 seedTourSeen
    await seedTourSeen(page, session.userId)

    await use(page)
  },
})

export { expect }
