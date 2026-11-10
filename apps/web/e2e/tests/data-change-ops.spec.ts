import { expect, test } from "../fixtures/base"

/**
 * #281 第三批：字典 · 定时任务 · 流程定义的变更记录入口。
 *
 * 字段、显示名、「只改草稿 / beat 回写触发计数不出记录」都由后端 pytest 读库断言；这里只验三个页面上的入口打得开、
 * 记录按对象对得上
 */
test.describe("字典 · 定时任务 · 流程定义的变更记录", () => {
  test("字典项：行操作「变更记录」—— 改过的标签前后都在", async ({ authedPage: page, api }) => {
    const run = Date.now().toString(36)
    const code = `e2edc_${run}`
    await api.post("/api/v1/sys/dict-types", { name: `E2E审计字典${run}`, code })
    const types = (await api.get(`/api/v1/sys/dict-types?code=${code}`)) as { items: Array<{ id: string }> }
    const typeId = types.items[0].id
    try {
      await api.post("/api/v1/sys/dict-datas", { type_id: typeId, label: "待处理", value: "e2e1", sort: 0, status: 1 })
      const datas = (await api.get(`/api/v1/sys/dict-datas?type_code=${code}`)) as { items: Array<{ id: string }> }
      const dataId = datas.items[0].id
      await api.put(`/api/v1/sys/dict-datas/${dataId}`, { type_id: typeId, label: "处理中", value: "e2e1", sort: 0, status: 1 })

      await page.goto(`/plugins/dict?type=${typeId}`)
      const tab = page.locator('[data-tab="/_auth/plugins/dict"]')
      await tab.getByTestId("data-actions-e2e1").click()
      await page.getByTestId("data-history-e2e1").click()
      const records = page.getByTestId("data-change-sheet").getByTestId("data-change-record")
      await expect(records).toHaveCount(2)
      const label = records.first().getByTestId("change-field-label")
      await expect(label).toContainText("待处理")
      await expect(label).toContainText("处理中")
    } finally {
      await api.del("/api/v1/sys/dict-types", { pks: [typeId] }).catch(() => undefined)
    }
  })

  test("定时任务：行操作「变更记录」—— 改过的 Crontab 前后都在", async ({ authedPage: page, api }) => {
    const name = `e2e-dc-${Date.now().toString(36)}`
    const body = { name, task: "maintenance.prune_logs", type: 1, crontab: "15 3 * * *" }
    const created = (await api.post("/api/v1/tasks/schedulers", body)) as { id: string }
    try {
      await api.put(`/api/v1/tasks/schedulers/${created.id}`, { ...body, crontab: "30 4 * * *" })

      await page.goto("/scheduler/manage")
      await page.locator('[data-tab="/_auth/scheduler/manage"]').getByTestId(`scheduler-actions-${created.id}`).click()
      await page.getByTestId(`history-scheduler-${created.id}`).click()
      const records = page.getByTestId("data-change-sheet").getByTestId("data-change-record")
      await expect(records).toHaveCount(2)
      await expect(records.first().getByTestId("change-field-crontab")).toContainText("30 4 * * *")
    } finally {
      await api.del("/api/v1/tasks/schedulers", { pks: [created.id] }).catch(() => undefined)
    }
  })

  test("流程定义：卡片上的「变更记录」打得开", async ({ authedPage: page, api }) => {
    const code = `E2E_DC_${Date.now().toString(36).toUpperCase()}`
    const created = (await api.post("/api/v1/sys/workflow/definitions", {
      code,
      name: `E2E审计流程${code}`,
      form: { schemaVersion: 1, fields: [] },
      model: { schemaVersion: 1, root: { type: "start", id: "start", next: null } },
    })) as { id: string }
    try {
      await page.goto("/workflow/definition")
      await page.locator('[data-tab="/_auth/workflow/definition"]').getByTestId(`wfd-more-${code}`).click()
      await page.getByTestId(`wfd-history-${code}`).click()
      const records = page.getByTestId("data-change-sheet").getByTestId("data-change-record")
      await expect(records).toHaveCount(1)
      await expect(records.first()).toContainText(`E2E审计流程${code}`)
    } finally {
      await api.del(`/api/v1/sys/workflow/definitions/${created.id}`).catch(() => undefined)
    }
  })
})
