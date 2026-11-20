import { expect, test } from "../fixtures/base"

// 浏览器在东京已过午夜，个人显示时区仍是 UTC；日期预设必须跟随后者。
test.use({ timezoneId: "Asia/Tokyo" })

test("登录日志的今天预设和请求边界按个人显示时区计算", async ({ authedPage: page }) => {
  await page.clock.install({ time: new Date("2026-08-22T00:30:00+09:00") })
  await page.route("**/api/v1/sys/users/me", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, data: { ...body.data, timezone: "UTC" } } })
  })

  await page.goto("/log/login")
  const tab = page.locator('[data-tab="/_auth/log/login"]')
  await expect(tab.getByTestId("query-bar")).toBeVisible()
  await tab.getByTestId("qb-input-time").click()
  await page.getByTestId("qb-input-time-preset-today").click()

  const request = page.waitForRequest((req) => {
    const url = new URL(req.url())
    return url.pathname === "/api/v1/logs/login" && url.searchParams.has("start_time")
  })
  await tab.getByTestId("qb-search").click()
  const url = new URL((await request).url())

  expect(url.searchParams.get("start_time")).toBe("2026-08-21T00:00:00.000Z")
  expect(url.searchParams.get("end_time")).toBe("2026-08-21T23:59:59.000Z")
  await expect(page).toHaveURL(/[?&]time=2026-08-21~2026-08-21(&|$)/)
})
