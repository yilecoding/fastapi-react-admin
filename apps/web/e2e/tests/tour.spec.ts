import { expect, loginPageAs, test } from "../fixtures/base"

/**
 * 功能引导（driver.js 外壳导览，`packages/platform/src/shell/tour/`）。
 *
 * 三条各守一个会**静默**坏的点：
 *   1. 首登自动弹、关掉后不再弹 —— 「看过了」这条记录是不是真的写进去、读出来
 *   2. 开着两个页签时高亮的是**可见**页签 —— 硬纪律 5：隐藏页签的 DOM 也在文档树里，
 *      driver.js 的字符串目标是全局 `document.querySelector`，`arch:check` 又抓不到
 *      node_modules 里的查询。这条红了就是 `targets.ts` 的作用域没锁住
 *   3. 目标不存在的步骤被**跳过**，不是变成一个居中的空弹窗 —— driver.js 默认对找不到的
 *      目标换一个 0×0 的 dummy 元素、气泡居中、不报错（`skipMissingElement` 默认 false）
 *
 * driver.js 的 DOM 没有 testid：气泡是 `.driver-popover`，被高亮的元素会被加上
 * `.driver-active-element`，进度文字在 `.driver-popover-progress-text`。
 * 按钮按可见文本定位（「下一步」/「完成」），这两个词就是 tour.ts 里传给它的。
 */
const popover = (page: import("@playwright/test").Page) => page.locator(".driver-popover")

async function openTourFromPalette(page: import("@playwright/test").Page) {
  // 🔴 按全局快捷键之前先等外壳挂上来（e2e 分册「按全局快捷键之前要先等外壳挂上来」）
  await expect(page.getByTestId("command-trigger")).toBeVisible()
  await page.keyboard.press("Control+k")
  await page.getByTestId("command-palette-input").fill("功能引导")
  await page.getByRole("option", { name: /功能引导/ }).click()
  await expect(popover(page)).toBeVisible()
}

test.describe("功能引导", () => {
  test("首次登录在仪表盘自动弹出；关掉之后刷新不再弹", async ({ page }) => {
    // 不用 authedPage —— 它会把导览标成已看过（fixtures/base.ts 的 seedTourSeen）
    await loginPageAs(page, "admin", "123456", { tourSeen: false })
    await page.goto("/dashboard")

    await expect(popover(page)).toBeVisible()
    await expect(popover(page)).toContainText("侧边栏")
    // 第一步高亮的是壳层侧边栏本体（`inShell('sidebar')`），不是页签里的什么东西
    await expect(page.locator(".driver-active-element")).toHaveAttribute("data-tour", "sidebar")

    await page.keyboard.press("Escape")
    await expect(popover(page)).toBeHidden()

    await page.reload()
    await expect(page.getByTestId("command-trigger")).toBeVisible()
    // 自动弹出有 800ms 的稳定期（tour-autostart.tsx 的 SETTLE_MS），等它过完再断言「没弹」——
    // 立刻断言会假绿：那一刻本来就还没到弹的时候
    await page.waitForTimeout(1500)
    await expect(popover(page)).toBeHidden()
  })

  test("开着两个页签时，「页面内容」高亮的是可见页签，不是先打开的隐藏页签", async ({
    authedPage: page,
  }) => {
    // 先开用户页（它在 DOM 里排前面），再从侧边栏开角色页 —— 现在角色页可见、用户页隐藏
    await page.goto("/system/user")
    await expect(page.locator('[data-tab*="/_auth/system/user"] [data-testid="page-title"]')).toBeVisible()
    await page.locator('a[href="/system/role"]').first().click()
    await expect(page.locator('[data-tab*="/_auth/system/role"][data-visible="true"]')).toBeVisible()
    await expect(page.locator('[data-tab*="/_auth/system/user"]')).toHaveAttribute("data-visible", "false")

    // 这条走顶栏的「帮助」按钮（第 3 条走 ⌘K，两个入口都盖到）
    await page.getByTestId("help-menu").click()
    await page.getByTestId("help-tour").click()
    await expect(popover(page)).toBeVisible()
    await expect(popover(page)).toContainText("侧边栏")
    await popover(page).getByRole("button", { name: "下一步" }).click()
    await expect(popover(page)).toContainText("多页签")
    await popover(page).getByRole("button", { name: "下一步" }).click()
    await expect(popover(page)).toContainText("页面内容")

    // 🔴 这就是硬纪律 5 的现场：两个 `[data-tab]` 都在文档树里，必须高亮可见的那个。
    // ⚠️ driver.js 1.8.0 只在 destroy 时统一摘 `driver-active-element`，走过的步骤（侧边栏 /
    // 标签条）身上这个类还留着（实测 3 个元素同时带它），所以只看带 `data-tab` 的那一个
    const active = page.locator(".driver-active-element[data-tab]")
    await expect(active).toHaveCount(1)
    await expect(active).toHaveAttribute("data-tab", /\/_auth\/system\/role/)
    await expect(active).toHaveAttribute("data-visible", "true")
    await expect(page.locator('[data-tab*="/_auth/system/user"].driver-active-element')).toHaveCount(0)
    // 隐藏的那个 display:none、矩形全 0 —— 高亮到它的话这里会量出一个 0×0
    const box = await active.boundingBox()
    expect(box, "高亮元素应该有可见矩形").not.toBeNull()
    expect(box!.width).toBeGreaterThan(200)
    expect(box!.height).toBeGreaterThan(100)

    await page.keyboard.press("Escape")
    await expect(popover(page)).toBeHidden()
  })

  test("目标不存在的步骤被跳过：关掉多页签后导览是 6 步，且没有「多页签」那一步", async ({
    authedPage: page,
  }) => {
    // 偏好里关掉标签条 → `TabBar` 整条 `return null` → `inShell('tab-bar')` 解析不到
    await page.addInitScript(() => {
      const KEY = "admin:prefs"
      const data = JSON.parse(localStorage.getItem(KEY) ?? "{}") as { state?: Record<string, unknown>; version?: number }
      localStorage.setItem(
        KEY,
        JSON.stringify({ version: data.version ?? 0, state: { ...(data.state ?? {}), showTabs: false } })
      )
    })
    await page.goto("/dashboard")
    await expect(page.getByTestId("command-trigger")).toBeVisible()
    await expect(page.getByTestId("tab-bar")).toHaveCount(0)

    await openTourFromPalette(page)
    // 七步定义、一步目标缺失 → 进度从 1 / 6 起
    await expect(popover(page).locator(".driver-popover-progress-text")).toHaveText("1 / 6")

    const titles: string[] = []
    for (let i = 0; i < 6; i += 1) {
      titles.push((await popover(page).locator(".driver-popover-title").textContent()) ?? "")
      if (i < 5) await popover(page).getByRole("button", { name: "下一步" }).click()
    }
    expect(titles).toEqual(["侧边栏", "页面内容", "命令面板", "通知中心", "个人中心", "帮助"])
    // 最后一步的主按钮是「完成」，点掉 → 整个导览关闭
    await popover(page).getByRole("button", { name: "完成" }).click()
    await expect(popover(page)).toBeHidden()
  })
})
