import { API_BASE, expect, loginSession, seedTourSeen, test } from "../fixtures/base"

/**
 * 登录会话（#138）：access token 只在内存里、页面加载时用 refresh cookie 静默恢复；
 * 会话结束（被踢 / 另一个标签页登出）由 socket 当场推过来，登录页说明原因；
 * 刷新时后端暂时不可用不能把人踢回登录页。
 *
 * ⚠️ 依赖 socket 推送的两条，先等 `<html data-presence="on">` 再动手 —— socket 还没连上时
 * 推送会落空，页面要等到下一次请求才发现，用例就只能猜一个毫秒数
 */
test.describe("登录会话", () => {
  test("刷新页面、新开标签页都不用重新登录", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await expect(page.getByTestId("user-menu")).toBeVisible()

    await page.reload()
    await expect(page.getByTestId("user-menu")).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard/)

    // 同一个浏览器里新开一个标签页（cookie 共用、内存不共用）
    const second = await page.context().newPage()
    await second.goto("/system/dept")
    await expect(second.getByTestId("user-menu")).toBeVisible()
    await expect(second).toHaveURL(/\/system\/dept/)
  })

  test("被管理员强制下线：页面当场回到登录页并说明原因", async ({ page, api }) => {
    const session = await loginSession()
    await page.context().addCookies(session.cookies)
    await seedTourSeen(page, session.userId)
    await page.goto("/dashboard")
    await expect(page.getByTestId("user-menu")).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-presence", "on")

    // 页面用 cookie 恢复出来的就是登录时那个会话 —— 会话 ID 整个会话不变
    await api.del(`/api/v1/monitors/sessions/${session.userId}?session_uuid=${session.sessionUuid}`)

    await expect(page).toHaveURL(/\/sign-in/)
    await expect(page.getByTestId("session-end-notice")).toContainText("管理员")
  })

  test("一个标签页登出，同一个浏览器的其它标签页跟着回到登录页", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await expect(page.getByTestId("user-menu")).toBeVisible()
    const other = await page.context().newPage()
    await other.goto("/dashboard")
    await expect(other.getByTestId("user-menu")).toBeVisible()
    await expect(other.locator("html")).toHaveAttribute("data-presence", "on")

    await page.getByTestId("user-menu").click()
    await page.getByTestId("logout").click()
    await expect(page).toHaveURL(/\/sign-in/)

    await expect(other).toHaveURL(/\/sign-in/)
    await expect(other.getByTestId("session-end-notice")).toContainText("其他标签页")
  })

  test("刷新时后端暂时不可用：停在「连不上服务器」，不踢回登录页", async ({ authedPage: page }) => {
    // 页面加载时手里没有 token，第一件事就是刷新 —— 让它撞上 502
    await page.route(`${API_BASE}/api/v1/auth/refresh`, (route) => route.fulfill({ status: 502, body: "Bad Gateway" }))
    await page.goto("/dashboard")
    await expect(page.getByTestId("server-unreachable-retry")).toBeVisible()
    await expect(page).not.toHaveURL(/\/sign-in/)

    // 后端回来了：点重试就接着用，会话一直是好的
    await page.unroute(`${API_BASE}/api/v1/auth/refresh`)
    await page.getByTestId("server-unreachable-retry").click()
    await expect(page.getByTestId("user-menu")).toBeVisible()
  })
})
