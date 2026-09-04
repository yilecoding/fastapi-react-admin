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
 * 所以需要一个能指定用户名的版本。注入方式同 `authedPage`（addInitScript +
 * sessionStorage），理由见本文件 `authedPage` 上的注释。
 */
export async function loginPageAs(
  page: Page,
  username: string,
  password: string,
  opts: { tourSeen?: boolean } = {}
): Promise<void> {
  const ctx = await request.newContext({ baseURL: API_BASE })
  const { token, sessionUuid } = await loginToken(ctx, username, password)
  const userId = await fetchMeId(ctx, token)
  await ctx.dispose()
  await page.addInitScript(([t, u]) => {
    sessionStorage.setItem("admin:access-token", t as string)
    sessionStorage.setItem("admin:session-uuid", u as string)
  }, [token, sessionUuid])
  // 默认把外壳导览标成已看过，理由见 seedTourSeen；只有导览自己的用例关掉它
  if (opts.tourSeen !== false) await seedTourSeen(page, userId)
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
  // 🔴 access token 存在 sessionStorage 里（`api-client/token-store.ts`），
  // 不是 localStorage、也不是 cookie —— Playwright 的 `storageState` 机制只保存
  // cookies 和 localStorage，**不包括 sessionStorage**，天然存不下这个 token。
  // 而这个应用的路由守卫是纯同步读 sessionStorage（`isAuthenticated()`），
  // 不会在页面启动时用 refresh cookie 静默换新 access token（那个刷新逻辑只在
  // 请求收到 401 时才触发，不是启动时的机制）—— 所以 storageState 复用登录态
  // 这条路对这个应用走不通，只能在每次导航前用 addInitScript 把 token 注入。
  authedPage: async ({ page }, use) => {
    const ctx = await request.newContext({ baseURL: API_BASE })
    const { token, sessionUuid } = await loginToken(ctx)
    const userId = await fetchMeId(ctx, token)
    await ctx.dispose()

    await page.addInitScript(([t, u]) => {
      sessionStorage.setItem("admin:access-token", t as string)
      sessionStorage.setItem("admin:session-uuid", u as string)
    }, [token, sessionUuid])
    // 外壳导览标成已看过，否则首屏就是一层遮罩 —— 见 seedTourSeen
    await seedTourSeen(page, userId)

    await use(page)
  },
})

export { expect }
