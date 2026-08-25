import { expect, test } from "../fixtures/base"

/**
 * 列表页的失败态（硬纪律 9：失败必须是可见状态，不是缺失状态）。
 *
 * 🔴 这条测试**只能靠造一个真实失败来验**：接口正常时两种写法看不出区别 ——
 * 漏接 `error` 的页面在接口 500 时把 `data?.items ?? []` 退化成空数组，
 * 渲染出的是「暂无数据」，和「筛选太窄、真的没数据」一模一样。用户会反复改
 * 筛选条件，而不知道接口挂了。所以这里用 `page.route` 把列表接口打成 502。
 *
 * 两条路径都要覆盖，它们的空态分支是分开写的：
 * - `DataTable`（用户管理）—— 错误行由组件自己渲染
 * - 手写 `<TableBody>` 的树形表（部门管理）—— 错误行要页面自己插在空态**之前**
 */
test.describe("列表页取数失败", () => {
  test("用户管理：502 显示错误块 + 重试，不是「暂无数据」", async ({ authedPage: page }) => {
    let fail = true
    // 只拦列表接口 —— 筛选栏的部门/角色下拉走的是另外两个端点，让它们正常
    await page.route(/\/api\/v1\/sys\/users\?/, async (route) => {
      if (!fail) return route.fallback()
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ code: 502, msg: "网关挂了（E2E 造的）", data: null }),
      })
    })

    await page.goto("/system/user")
    const table = page.getByTestId("user-table")

    const error = table.getByTestId("query-error")
    await expect(error).toBeVisible()
    await expect(error).toContainText("数据加载失败")
    // 关键断言：失败**不能**长成空态
    await expect(table).not.toContainText("暂无数据")

    // 重试要真的重新取数
    fail = false
    await table.getByTestId("query-error-retry").click()
    await expect(error).toBeHidden()
    // 用户表没挂行级 testid，用「表里出现了真实数据」来断言重取成功
    await expect(table).toContainText("admin@example.com")
  })

  test("部门管理：502 显示错误块，不是「没有匹配的部门」", async ({ authedPage: page }) => {
    await page.route(/\/api\/v1\/sys\/depts(\?|$)/, (route) =>
      route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ code: 502, msg: "网关挂了（E2E 造的）", data: null }),
      })
    )

    await page.goto("/system/dept")
    const table = page.getByTestId("dept-table")

    await expect(table.getByTestId("query-error")).toBeVisible()
    await expect(table).not.toContainText("没有匹配的部门")
  })
})
