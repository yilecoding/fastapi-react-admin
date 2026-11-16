/// <reference lib="dom" />

import type { Page } from "@playwright/test"

import { API_BASE, expect, loginSession, test } from "../fixtures/base"

// Capture the real transport before socket.io caches the WebSocket constructor.
// The app, handshake authentication, refresh cookies and backend stay real.
async function openPresence(page: Page) {
  await page.addInitScript(() => {
    const sockets: WebSocket[] = []
    Object.assign(window, { presenceSockets: sockets })
    Object.assign(window, { presenceNetwork: { blocked: false, attempts: 0 } })
    const Native = window.WebSocket
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        const network = (
          window as unknown as {
            presenceNetwork: { blocked: boolean; attempts: number }
          }
        ).presenceNetwork
        if (String(url).includes("/ws/socket.io")) {
          network.attempts++
          if (network.blocked)
            throw new Error("presence transport temporarily unavailable")
        }
        super(url, protocols)
        if (String(url).includes("/ws/socket.io")) sockets.push(this)
      }
    }
  })
  await page.goto("/system/dept")
  await expect(page.getByTestId("user-menu")).toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("data-presence", "on")
}

async function rejectNextHandshake(page: Page) {
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((n) => n.includes("/api-client/token-store.ts"))
    if (!url) throw new Error("token store was not loaded")
    const { tokenStore } = await import(/* @vite-ignore */ url)
    const parts = tokenStore.get().split(".")
    // Preserve identity but invalidate the signature: the real server must reject it.
    parts[2] = "invalid-signature"
    tokenStore.set(parts.join("."))
    const sockets = (window as unknown as { presenceSockets: WebSocket[] })
      .presenceSockets
    const transport = sockets.findLast((s) => s.readyState === WebSocket.OPEN)
    if (!transport) throw new Error("presence transport was not captured")
    transport.close()
  })
  await expect(page.locator("html")).toHaveAttribute("data-presence", "off")
}

test("握手被拒后刷新真实会话，恢复推送并可重载 #325", async ({
  authedPage: page,
  api,
}) => {
  await openPresence(page)
  const refreshed = page.waitForResponse(API_BASE + "/api/v1/auth/refresh")
  await rejectNextHandshake(page)
  expect((await refreshed).status()).toBe(200)
  await expect(page.locator("html")).toHaveAttribute("data-presence", "on", {
    timeout: 15000,
  })
  const me = (await api.get("/api/v1/sys/users/me")) as { id: string }
  const title = "Presence reconnect " + Date.now()
  const count = Number(
    await page
      .getByTestId("notification-badge")
      .textContent()
      .catch(() => "0")
  )
  await api.post("/api/v1/sys/notifications/send", {
    title,
    content: "Presence recovery regression",
    category: 0,
    link: null,
    recipient_ids: [me.id],
  })
  await expect(page.getByTestId("notification-badge")).toHaveText(
    String(count + 1)
  )
  await page.getByTestId("notification-bell").click()
  await expect(
    page.getByTestId("notification-item").filter({ hasText: title })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator("html")).toHaveAttribute("data-presence", "on")

  // A connected marker alone cannot prove session:ended still reaches its handler.
  const session = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .find((n) => n.includes("/api-client/token-store.ts"))!
    const { tokenStore } = await import(/* @vite-ignore */ url)
    return { userId: tokenStore.getUserId(), uuid: tokenStore.getSessionUuid() }
  })
  await api.del(
    "/api/v1/monitors/sessions/" +
      session.userId +
      "?session_uuid=" +
      session.uuid
  )
  await expect(page).toHaveURL(/sign-in/)
  await expect(page.getByTestId("session-end-notice")).toContainText("管理员")
  await expect(page.locator("html")).toHaveAttribute("data-presence", "off")
})

test("刷新暂时 503 后继续退避，不退出且恢复连接 #325", async ({
  authedPage: page,
}) => {
  await openPresence(page)
  let attempts = 0
  await page.route(API_BASE + "/api/v1/auth/refresh", (route) => {
    if (++attempts === 1)
      return route.fulfill({ status: 503, body: "temporarily unavailable" })
    return route.continue()
  })
  await rejectNextHandshake(page)
  await expect(page.locator("html")).toHaveAttribute("data-presence", "on", {
    timeout: 20000,
  })
  expect(attempts).toBe(2)
  await expect(page.getByTestId("user-menu")).toBeVisible()
})

test("离线期间会话被撤销，恢复时保留拒绝原因 #325", async ({ page, api }) => {
  const session = await loginSession()
  await page.context().addCookies(session.cookies)
  await openPresence(page)
  await rejectNextHandshake(page)
  await api.del(
    "/api/v1/monitors/sessions/" +
      session.userId +
      "?session_uuid=" +
      session.sessionUuid
  )
  await expect(page).toHaveURL(/sign-in/, { timeout: 15000 })
  await expect(page.getByTestId("session-end-notice")).toContainText("管理员")
  await expect(page.locator("html")).toHaveAttribute("data-presence", "off")
})

test("恢复在途时卸载外壳，不能重建旧 socket #325", async ({
  authedPage: page,
}) => {
  await openPresence(page)
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const refreshStarted = page.waitForRequest(API_BASE + "/api/v1/auth/refresh")
  await page.route(API_BASE + "/api/v1/auth/refresh", async (route) => {
    await blocked
    await route.fulfill({ status: 503, body: "temporarily unavailable" })
  })
  try {
    await rejectNextHandshake(page)
    await refreshStarted
    const count = await page.evaluate(
      () =>
        (window as unknown as { presenceSockets: WebSocket[] }).presenceSockets
          .length
    )
    // Exercise real session-expiry cleanup while recovery awaits a response.
    await page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .find((n) => n.includes("/api-client/client.ts"))!
      const { endSession } = await import(/* @vite-ignore */ url)
      endSession({ reason: "logout", message: null })
    })
    await expect(page).toHaveURL(/sign-in/)
    release()
    await page.clock.install()
    await page.clock.fastForward(60000)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { presenceSockets: WebSocket[] })
            .presenceSockets.length
      )
    ).toBe(count)
    await expect(page.locator("html")).toHaveAttribute("data-presence", "off")
  } finally {
    release()
  }
})

test("传输失败超过五轮后仍会在网络恢复时连接 #325", async ({
  authedPage: page,
}) => {
  await page.clock.install()
  await openPresence(page)
  await page.evaluate(() => {
    const state = window as unknown as {
      presenceNetwork: { blocked: boolean; attempts: number }
      presenceSockets: WebSocket[]
    }
    state.presenceNetwork.blocked = true
    state.presenceSockets
      .findLast((s) => s.readyState === WebSocket.OPEN)!
      .close()
  })
  await expect(page.locator("html")).toHaveAttribute("data-presence", "off")
  const attempts = () =>
    page.evaluate(
      () =>
        (window as unknown as { presenceNetwork: { attempts: number } })
          .presenceNetwork.attempts
    )
  for (let i = 0; i < 7; i++) {
    const before = await attempts()
    await page.clock.fastForward(31000)
    // A constructor failure can also leave the Engine.IO opening timeout pending.
    await page.clock.fastForward(31000)
    await expect.poll(attempts).toBeGreaterThan(before)
  }
  await page.evaluate(() => {
    ;(
      window as unknown as { presenceNetwork: { blocked: boolean } }
    ).presenceNetwork.blocked = false
    window.dispatchEvent(new Event("online"))
  })
  await page.clock.fastForward(31000)
  await expect(page.locator("html")).toHaveAttribute("data-presence", "on")
})
