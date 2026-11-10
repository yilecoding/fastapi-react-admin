import { expect, test } from "../fixtures/base"

/**
 * #281 第二批：数据权限 · 通知策略的变更记录。
 *
 * 字段、取值的显示名、集合字段的 + / − 由后端 pytest 读库断言；这里只验界面上的入口：
 * 数据范围左栏的行操作开抽屉（规则那一项按名字显示）· 通知策略页的「变更记录」带着筛选去「数据变更」页
 */
test.describe("数据权限 · 通知策略的变更记录", () => {
  test("数据范围：左栏行操作「变更记录」—— 挂上的规则按名字显示", async ({ authedPage: page, api }) => {
    const run = Date.now().toString(36).toUpperCase()
    const ruleName = `E2E审计规则-${run}`
    const scopeName = `E2E审计范围-${run}`
    await api.post("/api/v1/sys/data-rules", {
      name: ruleName,
      model: "Dept",
      column: "code",
      operator: 0,
      expression: 0,
      value: `E2E${run}`,
    })
    await api.post("/api/v1/sys/data-scopes", { name: scopeName, status: 1 })
    const rules = (await api.get(`/api/v1/sys/data-rules?name=${encodeURIComponent(ruleName)}`)) as {
      items: Array<{ id: string; name: string }>
    }
    const scopes = (await api.get(`/api/v1/sys/data-scopes?name=${encodeURIComponent(scopeName)}`)) as {
      items: Array<{ id: string; name: string }>
    }
    const ruleId = rules.items.find((r) => r.name === ruleName)!.id
    const scopeId = scopes.items.find((s) => s.name === scopeName)!.id
    try {
      await api.put(`/api/v1/sys/data-scopes/${scopeId}/rules`, { rules: [ruleId] })

      await page.goto(`/system/data-permission?scope=${scopeId}`)
      const tab = page.locator('[data-tab="/_auth/system/data-permission"]')
      await tab.getByTestId(`scope-actions-${scopeId}`).click()
      await page.getByTestId(`scope-history-${scopeId}`).click()
      const records = page.getByTestId("data-change-sheet").getByTestId("data-change-record")
      // 新的在前：挂上规则，再是新建
      await expect(records).toHaveCount(2)
      await expect(records.first().getByTestId("change-field-rules")).toContainText(ruleName)
    } finally {
      await api.put(`/api/v1/sys/data-scopes/${scopeId}/rules`, { rules: [] }).catch(() => undefined)
      await api.del("/api/v1/sys/data-rules", { pks: [ruleId] }).catch(() => undefined)
      await api.del("/api/v1/sys/data-scopes", { pks: [scopeId] }).catch(() => undefined)
    }
  })

  test("通知策略：「变更记录」去数据变更页，按通知策略筛好", async ({ authedPage: page, api }) => {
    // 只动 workflow.timeout × 短信这一格（notify-channels.spec.ts 用的是 workflow.cc × 邮件）。改完立刻改回默认值
    const POLICIES = "/api/v1/sys/notification-channels/policies"
    const rows = (await api.get(POLICIES)) as Array<{
      kind: string
      cells: Array<{ channel: string; mode: string; default: string }>
    }>
    const cell = rows.find((r) => r.kind === "workflow.timeout")?.cells.find((c) => c.channel === "sms")
    expect(cell, "前置：workflow.timeout × 短信这一格存在").toBeTruthy()
    const changed = cell!.default === "forced" ? "off" : "forced"
    await api.put(POLICIES, { items: [{ kind: "workflow.timeout", channel: "sms", mode: changed }] })
    try {
      await page.goto("/notify/policy")
      await page.locator('[data-tab="/_auth/notify/policy"]').getByTestId("policy-history").click()
      await expect(page).toHaveURL(/\/log\/change\?.*entity_type=notification_policy/)
      const table = page.locator('[data-tab="/_auth/log/change"]').getByTestId("change-table")
      await expect(table).toHaveAttribute("data-fetching", "false")
      // 按对象名找这一格，不看「第一行」：notify-channels.spec.ts 并行地在改另一格，可能比这条新（#286 评审）
      await expect(table.locator("tbody tr", { hasText: "workflow.timeout · sms" }).first()).toBeVisible()
    } finally {
      await api.put(POLICIES, { items: [{ kind: "workflow.timeout", channel: "sms", mode: cell!.default }] })
    }
  })
})
