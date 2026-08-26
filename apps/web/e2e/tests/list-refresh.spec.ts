import { expect, test } from "../fixtures/base"

/**
 * 列表页的「取最新」三条路径（issue #36 的回归）。
 *
 * 🔴 这一组**只能靠数请求**来验：这三个动作在界面上都长得像「有反应」
 * （URL 变了 / 按钮转了一下 / 页面重挂了），而它们曾经**一个请求都不发** ——
 * 界面上和「刷新过了，数据恰好没变」完全无法区分。
 */
test.describe("列表页刷新", () => {
  test("条件未变点搜索、点刷新、标签页重新加载，三者都必须真的重取", async ({
    authedPage: page,
  }) => {
    const hits: string[] = []
    page.on("request", (r) => {
      const u = new URL(r.url())
      if (u.pathname === "/api/v1/sys/users") hits.push(u.search)
    })

    await page.goto("/system/user")
    await expect(page.getByTestId("user-table")).toBeVisible()
    await expect.poll(() => hits.length).toBeGreaterThan(0)

    // ① 条件一个字都没改，再点一次搜索 —— 用户的心智模型是「照这些条件再查一次」
    const afterLoad = hits.length
    await page.getByRole("button", { name: "搜索" }).click()
    await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThan(afterLoad)

    // ② 工具行的刷新按钮：只重取，筛选/分页都留着
    const beforeRefresh = hits.length
    const url = page.url()
    await page.getByTestId("list-refresh").click()
    await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThan(beforeRefresh)
    expect(page.url()).toBe(url)

    // ③ 标签条的「重新加载当前页」—— 曾经在 staleTime(30s) 内是空操作
    const beforeReload = hits.length
    await page.getByTestId("tab-reload").click()
    await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThan(beforeReload)
  })

  test("刷新会清掉行选中：重取回来的行可能已经不在了", async ({ authedPage: page }) => {
    await page.goto("/system/user")
    const table = page.getByTestId("user-table")
    await expect(table.locator('[data-slot="table-body"] [data-slot="table-row"]').first()).toBeVisible()

    // 勾一行（超管那行不给选，见 enableRowSelection）——「已选 N 项」出现即算选上
    await table.getByRole("checkbox").nth(1).click()
    await expect(page.getByTestId("bulk-count")).toBeVisible()

    // 🔴 刷新要把选中清掉：重取回来的行可能已经不在了，而选中态是按 id 存的 ——
    // 留着它，接下来的批量删除会打到用户看不见的记录上
    await page.getByTestId("list-refresh").click()
    await expect(page.getByTestId("bulk-count")).toBeHidden()
  })
})
