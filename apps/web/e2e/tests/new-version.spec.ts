import { expect, test } from "../fixtures/base"

/**
 * 「服务端发新版了，请刷新」（见 `apps/web/src/lib/app-version.ts`）。
 *
 * 造假响应是**必要**的，理由同 `list-error.spec.ts`：真实环境里「发新版」
 * 这件事没法在一条测试里发生 —— 要么真去构建两次，要么让服务器报一个
 * 不一样的 buildId。这里用 `page.route` 直接给 `/version.json` 换个值。
 *
 * ⚠️ 开发服务器上**没有** `version.json`（它是构建产物），所以第二条断言
 * （404 不能被当成发新版）验的是真实的开发期行为，不是假设。
 */
test.describe("新版本提示", () => {
  test("服务端 buildId 变了 → 弹一条带「刷新」的提示", async ({ authedPage: page }) => {
    await page.route("**/version.json", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ buildId: "e2e-new-build" }),
      })
    )

    await page.goto("/dashboard")

    const toast = page.getByTestId("toast")
    await expect(toast).toContainText("已发布新版本")
    // 🔴 不能自动刷新 —— 用户可能正在填一张长表单。只给按钮
    await expect(toast.getByRole("button", { name: "刷新" })).toBeVisible()
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test("拿不到 version.json（开发期就是这样）不能弹提示", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await expect(page.getByTestId("dash-greeting")).toBeVisible()
    await expect(page.getByTestId("toast")).toHaveCount(0)
  })
})
