import type { Route } from "@playwright/test"

import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 数据变更审计（#260）：改了什么在三处都看得到 —— 对象自己的「变更记录」抽屉 · 「数据变更」页 · 跳去那次请求的操作日志。
 *
 * ⚠️ 不断言操作日志那一行出现：操作日志是后台消费者批量落库的（`OPERA_LOG_QUEUE_TIMEOUT` 默认 60 秒才刷一批），
 * 等它就是让这条用例平白多跑一分钟。「按 trace_id 筛得到」由后端 `test_data_change.py::test_opera_log_filters_by_trace_id` 守着，
 * 这里只验「点了会带着 trace_id 过去」
 */
test.describe("数据变更审计", () => {
  test("改部门名 → 行操作「变更记录」看到旧值 → 新值 → 数据变更页按对象筛 → 详情跳这次请求的操作日志", async ({
    authedPage: page,
    api,
  }) => {
    const code = uniqueCode("E2EDC")
    const before = `E2E审计部门${code}`
    // 🔴 新名字不能包含旧名字：写成 `${before}改` 的话，「显示了旧值」这句断言永远成立（变异检验时抓到的）
    const after = `E2E改名后${code}`

    await api.post("/api/v1/sys/depts", { code, name: before, status: 1, sort: 0 })
    const id = ((await api.get(`/api/v1/sys/depts?code=${code}`)) as Array<{ id: string }>)[0].id
    await api.put(`/api/v1/sys/depts/${id}`, { name: after, status: 1, sort: 0 })

    try {
      // ── 部门页：行操作 → 变更记录 ──
      await page.goto(`/system/dept?code=${code}`)
      await page.getByTestId(`dept-actions-${after}`).click()
      await page.getByTestId(`dept-history-${after}`).click()
      const sheet = page.getByTestId("data-change-sheet")
      await expect(sheet).toBeVisible()
      const records = sheet.getByTestId("data-change-record")
      // 新的在前：先是改名，再是新建
      await expect(records).toHaveCount(2)
      const rename = records.first().getByTestId("change-field-name")
      await expect(rename).toContainText(before)
      await expect(rename).toContainText(after)
      await expect(records.nth(1)).toContainText("已新建")

      // ── 单字段历史：点字段名只看这一个字段，别的字段不再列出来 ──
      await expect(records.nth(1).getByTestId("change-field-code")).toBeVisible()
      await records.first().getByTestId("field-history-name").click()
      await expect(sheet.getByTestId("history-field-filter")).toContainText("部门名称")
      // 新建那条也改过名称（从无到有），所以还是两条，但只剩「部门名称」一行
      await expect(records).toHaveCount(2)
      await expect(sheet.getByTestId("change-field-code")).toHaveCount(0)
      await sheet.getByTestId("history-field-clear").click()
      await expect(records.nth(1).getByTestId("change-field-code")).toBeVisible()
      await page.keyboard.press("Escape")

      // ── 数据变更页：按对象筛（地址栏带上 entity_type / entity_id）──
      // 多带一个无关的筛选（操作人）：后面点字段名时它要被清掉
      await page.goto(`/log/change?entity_type=dept&entity_id=${id}&actor=admin`)
      const tab = page.locator('[data-tab="/_auth/log/change"]')
      const table = tab.getByTestId("change-table")
      await expect(table).toHaveAttribute("data-fetching", "false")
      await expect(table.locator("tbody tr")).toHaveCount(2)
      await expect(table.locator("tbody tr").first()).toContainText("部门名称")

      // 点时间开详情：完整的字段对比 + 出处
      await table.locator('[data-testid^="open-change-"]').first().click()
      const detail = page.getByTestId("data-change-detail")
      await expect(detail.getByTestId("change-field-name")).toContainText(after)

      // 详情里点字段名：这个对象这一个字段的历史，条件进地址栏（能分享）
      await detail.getByTestId("field-history-name").click()
      await expect(page).toHaveURL(/field=name/)
      // 只留对象 + 字段：带着别的筛选，「这个字段的历史」会被悄悄缩小（评审抓到的）
      await expect(page).not.toHaveURL(/actor=/)
      await expect(table).toHaveAttribute("data-fetching", "false")
      await expect(table.locator("tbody tr")).toHaveCount(2)

      // 导出按钮在（权限码 log:change:export，admin 是超管）；完整性校验只给超管
      await expect(tab.getByTestId("export-changes")).toBeVisible()
      await tab.getByTestId("integrity-check").click()
      const integrity = page.getByTestId("integrity-dialog")
      await expect(integrity.getByTestId("integrity-result")).toHaveAttribute("data-ok", "true")
      // E2E 环境没配 DATA_CHANGE_CHAIN_KEY：要说清楚现在只防手滑改库
      await expect(integrity.getByTestId("integrity-no-key")).toBeVisible()
      await page.keyboard.press("Escape")

      await table.locator('[data-testid^="open-change-"]').first().click()

      // 跳去这次请求的操作日志：带着 trace_id
      await detail.getByTestId("change-to-opera-log").click()
      await expect(page).toHaveURL(/\/log\/opera\?.*trace_id=/)
      // 🔴 抽屉要跟着走掉。原来只断言了地址栏：抽屉的 portal 挂在 <body> 上，关闭和切 tab 落在同一次提交里，
      // 退场动画等不到 effect（原页签进了后台），一个关不掉的空壳压在操作日志页上（shell 分册「从浮层里 <Link> 跳走」）
      await expect(detail).toBeHidden()
      // 前台点得动：没有残留的遮罩挡着
      await page.locator('[data-tab="/_auth/log/opera"]').getByTestId("list-refresh").click()
    } finally {
      await api.del("/api/v1/sys/depts/" + id)
    }
  })

  test("操作日志详情「这次改了什么」→ 去数据变更看全部：抽屉跟着走掉", async ({ authedPage: page }) => {
    // 两个接口都在**真响应**上换数据：操作日志是批量落库的（见文件头），等不到真的那一行；一次请求改 50 个以上对象
    // 也不好造。验的只是前端「从抽屉里的链接跳去别的 tab」这一件事
    const traceId = `e2e${Date.now().toString(16)}`
    const now = new Date().toISOString()
    const log = {
      id: "1", trace_id: traceId, username: "admin", method: "PUT", title: "修改部门", path: "/api/v1/sys/depts/1",
      ip: "127.0.0.1", country: null, region: null, city: null, user_agent: null, os: null, browser: null, device: null,
      args: null, request_headers: null, response_headers: null, response_body: null,
      status: 1, code: "200", msg: "Success", cost_time: 12, opera_time: now,
    }
    const change = {
      id: "1", trace_id: traceId, entity_type: "dept", entity_id: "1", entity_label: "E2E部门", action: "update",
      changes: [], actor_id: null, actor_name: "admin", source: "web", source_ref: null, ip: "127.0.0.1", created_time: now,
    }
    const swap = (items: unknown[], total: number) => async (route: Route) => {
      const response = await route.fetch()
      const json = await response.json()
      json.data.items = items
      json.data.total = total
      await route.fulfill({ response, json })
    }
    await page.route(/\/api\/v1\/logs\/opera\?/, swap([log], 1))
    // 只换「这次改了什么」那一个查询（size=50）；跳过去之后数据变更页自己的列表照常打到后端
    await page.route(/\/api\/v1\/logs\/changes\?.*size=50/, swap([change], 61))

    await page.goto("/log/opera")
    await page.locator('[data-tab="/_auth/log/opera"]').getByTestId("open-detail-1").click()
    const detail = page.getByTestId("opera-log-detail")
    const more = detail.getByTestId("trace-changes-more")
    await expect(more).toContainText("60")
    await more.click()
    await expect(page).toHaveURL(new RegExp(`/log/change\\?.*trace_id=${traceId}`))
    await expect(detail).toBeHidden()
    await page.locator('[data-tab="/_auth/log/change"]').getByTestId("list-refresh").click()
  })
})
