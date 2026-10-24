import { createApiClient, expect, loginPageAs, test } from "../fixtures/base"

/**
 * AI 自动同意（#111 第 5 条）的界面：设计器里的开关 · 审批进度里那一步怎么画。
 *
 * 放闸 / 只同意不驳回 / 提交后没人动过才做 / 关掉立刻停 / 不给自己打分，都在 pytest 里（`test_ai_approve.py`）。
 * E2E 没有 worker 也没有模型，「被 AI 自动同意过」的详情用 `route.fetch()` 取真接口、再改成那个形状 ——
 * 这里验的是**那一步不能画成「某某 已同意」**：他没同意过。
 */
const CODE = `E2EAIA_${Date.now().toString(36).toUpperCase()}`
let definitionId = ""
let instanceId = ""

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  const { api, dispose } = await createApiClient()
  const users = (await api.get("/api/v1/sys/users?username=zhangwei")) as { items: { id: string; username: string }[] }
  const approverId = String(users.items.find((u) => u.username === "zhangwei")!.id)
  const form = { schemaVersion: 1, fields: [{ id: "f_reason", type: "text", label: "事由" }] }
  const model = {
    schemaVersion: 1,
    root: {
      type: "start",
      id: "start",
      next: {
        type: "approval",
        id: "n1",
        name: "主管审批",
        mode: "any",
        assignee: { kind: "user", user_ids: [approverId] },
        onEmpty: "reject",
        fieldPerms: {},
        next: null,
      },
    },
  }
  const created = (await api.post("/api/v1/sys/workflow/definitions", { code: CODE, name: `E2E 自动同意 ${CODE}`, form, model })) as {
    id: string
  }
  definitionId = created.id
  expect(((await api.post(`/api/v1/sys/workflow/definitions/${definitionId}/publish`)) as { published: boolean }).published).toBe(true)
  const started = (await api.post("/api/v1/sys/workflow/instances", {
    code: CODE,
    form: { f_reason: "去上海见客户" },
    key: `e2e-${Date.now()}`,
  })) as { instance_id: string }
  instanceId = String(started.instance_id)
  await dispose()
})

test("设计器：没开 AI 预审时开不了；开了之后能开、门槛存得住", async ({ page }) => {
  await loginPageAs(page, "admin", "123456")
  await page.goto(`/workflow/definition?id=${definitionId}&step=flow&sel=n1`)
  const scope = page.locator('[data-tab="/_auth/workflow/definition"]')
  await expect(scope.getByTestId("node-ai-approve-switch")).toBeDisabled()
  await expect(scope.getByTestId("node-ai-approve")).toBeVisible()

  await scope.getByTestId("wfd-step-basic").click()
  await scope.getByTestId("wfd-ai-enabled").click()
  await scope.getByTestId("wfd-step-flow").click()
  await scope.getByTestId("flow-node-n1").click()
  await expect(scope.getByTestId("node-ai-approve-switch")).toBeEnabled()
  await scope.getByTestId("node-ai-approve-switch").click()
  await expect(scope.getByTestId("node-ai-approve-samples")).toHaveValue("30")
  // 像人一样一个键一个键地打：原来每敲一键就夹到范围里，「95」会变成 9→80→805→100
  for (const [id, typed] of [["node-ai-approve-samples", "50"], ["node-ai-approve-precision", "90"]] as const) {
    const box = scope.getByTestId(id)
    await box.click()
    await box.press("ControlOrMeta+a")
    await box.press("Backspace")
    await box.pressSequentially(typed, { delay: 50 })
    await expect(box).toHaveValue(typed)
  }
  await scope.getByTestId("wfd-save").click()
  await expect(scope.getByTestId("wfd-save")).toBeDisabled()

  await page.reload()
  await expect(scope.getByTestId("node-ai-approve-samples")).toHaveValue("50")
  await expect(scope.getByTestId("node-ai-approve-precision")).toHaveValue("90")
})

test("审批进度：AI 自动同意的那一步画成「AI 自动同意」、人那一栏是「没经手」，不是「已同意」", async ({ page }) => {
  await page.route(new RegExp(`/api/v1/sys/workflow/instances/${instanceId}$`), async (route) => {
    const res = await route.fetch()
    const body = await res.json()
    const d = body.data
    for (const tk of d.tasks) if (tk.node_id === "n1") Object.assign(tk, { status: "canceled", finished_time: new Date().toISOString() })
    d.instance.status = "approved"
    d.capabilities = []
    d.records.push({
      id: "9000000000000000001",
      task_id: null,
      action: "ai_approve",
      actor_type: "ai",
      actor_id: null,
      actor_name: "Qwen3-VL",
      node_id: "n1",
      node_name: "主管审批",
      target_user_name: null,
      opinion: "AI 预审建议通过；这个流程上它建议通过的 40 张单里，人最后通过了 97.5%，已自动同意",
      detail: { samples: 40, precision: 0.975 },
      created_time: new Date().toISOString(),
    })
    await route.fulfill({ response: res, json: body })
  })
  await loginPageAs(page, "admin", "123456")
  await page.goto(`/workflow/inbox?id=${instanceId}`)
  const timeline = page.getByTestId("wf-timeline")
  await expect(timeline).toContainText("AI 自动同意")
  await expect(timeline).toContainText("没经手")
  await expect(timeline).toContainText("Qwen3-VL")
  await expect(timeline).not.toContainText("已同意")
  await expect(timeline).not.toContainText("已跳过")
})
