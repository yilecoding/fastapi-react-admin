import { test as base, expect, request } from "@playwright/test"

import type { APIRequestContext, Page } from "@playwright/test"

export const API_BASE = process.env.E2E_API_BASE ?? "http://127.0.0.1:8001"

async function loginToken(ctx: APIRequestContext) {
  const res = await ctx.post("/api/v1/auth/login/swagger", {
    params: { username: "admin", password: "123456" },
  })
  if (!res.ok()) throw new Error(`登录失败（HTTP ${res.status()}）：${await res.text()}`)
  const body = (await res.json()) as { access_token: string; session_uuid: string }
  return { token: body.access_token, sessionUuid: body.session_uuid }
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
    await ctx.dispose()

    await page.addInitScript(([t, u]) => {
      sessionStorage.setItem("admin:access-token", t as string)
      sessionStorage.setItem("admin:session-uuid", u as string)
    }, [token, sessionUuid])

    await use(page)
  },
})

export { expect }
