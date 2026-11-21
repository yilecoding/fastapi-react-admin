import type { Page, Route } from "@playwright/test"

import { expect, test } from "../fixtures/base"

/**
 * 个人中心「设置密码」（#402）：第三方登录建的无密码账号。
 *
 * 真走一遍要 GitHub / Google 的回调，这里没有；后端那一侧（重新授权 → 凭据 → 设密码）由
 * `plugin/oauth2/tests/test_passwordless_set_password.py` 真请求测过。这条只验界面的三种状态：
 * 没验证 → 只给「用 X 验证身份」，没有「当前密码」框；验证过 → 只要新密码；状态取不到 → 错误 + 重试，
 * 不退回要旧密码的那张表单（硬纪律 9）。
 *
 * admin 本人是有密码的，所以 `password-status` / `bindings` 用 `page.route` 改写成无密码账号的样子。
 * ⚠️ 定位按 routeId 收窄（硬纪律 5）。
 */
const BLOCK = '[data-tab="/_auth/profile"] [data-testid="profile-password"]'

const ok = (data: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ code: 200, msg: "ok", data }),
})

async function asPasswordless(
  page: Page,
  status: { has_password: boolean; reauth_verified: boolean } | "fail",
  bindings: string[] = ["Github"]
) {
  await page.route("**/api/v1/sys/users/me/password-status", (route: Route) =>
    status === "fail"
      ? route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ code: 502, msg: "gateway failed (E2E)", data: null }),
        })
      : route.fulfill(ok(status))
  )
  await page.route("**/api/v1/oauth2/me/bindings", (route: Route) => route.fulfill(ok(bindings)))
}

test("没验证身份：只给已绑定的第三方账号去验证，没有「当前密码」框", async ({ authedPage: page }) => {
  await asPasswordless(page, { has_password: false, reauth_verified: false })
  let reauthAsked = ""
  await page.route("**/api/v1/oauth2/me/reauth?**", (route: Route) => {
    reauthAsked = new URL(route.request().url()).searchParams.get("source") ?? ""
    // 回一个错误，免得真跳去第三方；只验「点了会去要哪个来源的链接」+ 失败看得见
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ code: 400, msg: "E2E 拦下的跳转", data: null }),
    })
  })

  await page.goto("/profile?section=security")
  const block = page.locator(BLOCK)
  await expect(block).toContainText("设置密码")
  await expect(block.getByTestId("p-old")).toHaveCount(0)
  await expect(block.getByTestId("p-new")).toHaveCount(0)
  await expect(block.getByTestId("p-reauth-Google")).toHaveCount(0) // 没绑的不给
  await block.getByTestId("p-reauth-Github").click()
  await expect(block.getByTestId("card-error")).toContainText("E2E 拦下的跳转")
  expect(reauthAsked).toBe("Github")
})

test("一个第三方账号都没绑：说清楚只能找管理员", async ({ authedPage: page }) => {
  await asPasswordless(page, { has_password: false, reauth_verified: false }, [])
  await page.goto("/profile?section=security")
  await expect(page.locator(BLOCK).getByTestId("p-reauth-none")).toBeVisible()
})

test("验证过：只要新密码 + 确认，提交不带 old_password，后端的拒绝原样显示", async ({
  authedPage: page,
}) => {
  await asPasswordless(page, { has_password: false, reauth_verified: true })
  let body: Record<string, unknown> | null = null
  await page.route("**/api/v1/sys/users/me/password", (route: Route) => {
    body = route.request().postDataJSON() as Record<string, unknown>
    // 不放到真后端：admin 有密码，真改了会把会话全撤掉
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ code: 400, msg: "密码太弱（E2E）", data: null }),
    })
  })

  await page.goto("/profile?section=security")
  const block = page.locator(BLOCK)
  await expect(block.getByTestId("p-reauth-ok")).toBeVisible()
  await expect(block.getByTestId("p-old")).toHaveCount(0)
  await block.getByTestId("p-new").fill("Nw1@abcdef")
  await block.getByTestId("p-confirm").fill("Nw1@abcdef")
  await block.getByTestId("p-password-save").click()
  await expect(block.getByTestId("card-error")).toContainText("密码太弱（E2E）")
  expect(body).toEqual({ new_password: "Nw1@abcdef", confirm_password: "Nw1@abcdef" })
})

test("状态取不到：错误 + 重试，不退回要旧密码的表单", async ({ authedPage: page }) => {
  await asPasswordless(page, "fail")
  await page.goto("/profile?section=security")
  const block = page.locator(BLOCK)
  await expect(block.getByTestId("query-error")).toBeVisible()
  await expect(block.getByTestId("p-old")).toHaveCount(0)

  await page.unroute("**/api/v1/sys/users/me/password-status")
  await block.getByTestId("query-error-retry").click()
  // admin 真有密码：重试后回到「修改密码」，要旧密码
  await expect(block.getByTestId("p-old")).toBeVisible()
})
