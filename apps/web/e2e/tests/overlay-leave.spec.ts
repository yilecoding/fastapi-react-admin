import { expect, test } from "../fixtures/base"

/**
 * 从浮层（下拉菜单 / 抽屉）里的链接跳去别的 tab：浮层要跟着走掉。
 *
 * 浮层的 portal 挂在 `<body>` 上，不在 `<Activity>` 隐藏的那棵 DOM 里。跳走和关浮层落在同一次提交里，
 * 原来那个 tab 进了后台、effect 被销毁，Base UI 等不到退场动画结束 —— 浮层留在新的那一页上，关不掉。
 * 修法是点链接时把浮层整个卸载（菜单换 key 重挂），见 shell 分册「从浮层里 `<Link>` 跳走」。
 * 两个共用组件各一条；数据变更 / 操作日志详情抽屉里的那两处在 `data-change.spec.ts`
 */
test.describe("从浮层里的链接跳走", () => {
  test("导出菜单 →「导出记录」：菜单不留在个人中心上", async ({ authedPage: page }) => {
    await page.goto("/system/user")
    await page.locator('[data-tab="/_auth/system/user"]').getByTestId("export").click()
    const history = page.getByTestId("export-history")
    await history.click()
    await expect(page).toHaveURL(/\/profile\?.*section=exports/)
    await expect(history).toBeHidden()
    // 前台点得动：没有残留的菜单挡着
    await page.locator('[data-tab="/_auth/profile"]').getByTestId("settings-nav-security").click()
    await expect(page).toHaveURL(/section=security/)
  })

  test("行操作菜单里的链接（开放应用 →「调用日志」）：菜单不留在调用日志页上", async ({ authedPage: page, api }) => {
    const code = `E2E_OL_${Date.now().toString(36).toUpperCase()}`
    const app = (await api.post("/api/v1/open-apps", { code, name: "E2E 浮层跳走", scopes: ["user:read"] })) as {
      id: string
    }
    try {
      await page.goto("/open/app")
      await page.locator('[data-tab="/_auth/open/app"]').getByTestId(`row-actions-${code}`).click()
      const logs = page.getByTestId(`logs-${code}`)
      await logs.click()
      await expect(page).toHaveURL(/\/open\/log\?.*app=/)
      await expect(logs).toBeHidden()
      await page.locator('[data-tab="/_auth/open/log"]').getByTestId("list-refresh").click()
    } finally {
      await api.del(`/api/v1/open-apps/${app.id}`).catch(() => undefined)
    }
  })
})
