import { request } from "@playwright/test"

import { API_BASE, createApiClient, expect, loginPageAs, loginToken, test } from "../fixtures/base"

/**
 * AI 预审（#111 第 2 条）的界面：详情顶上的面板 + 设计器里的开关。
 *
 * 后端（派发时机、按人裁理由、注入、失败可见）在 pytest 里钉死了（`plugin/workflow/tests/test_ai_review.py`）。
 * E2E 环境没有模型也不保证有 Celery worker，所以「有结论 / 失败」两种状态用 `page.route` 固定接口返回 ——
 * 这里验的是**界面把每种状态都画出来了**，尤其是失败不能长成「没有预审」（硬纪律 9）。
 * 发起人那条和「不 mock」那条打的是真接口。
 *
 * 🔴 **账号用 lina（发起）/ liuyang（审批），不要和 `workflow.spec.ts` 共用孙强 / 赵磊。**
 * 演示账号都是 `is_multi_login = false`：每登录一次就删掉这个人所有旧 token。两个文件并行跑、
 * 登同一个人，就互相把对方踢下线 —— 实测 CI 上 `workflow.spec.ts` 的主流程连挂两轮，
 * 服务端日志里是孙强那几个请求突然全 401，而单跑哪个文件都是绿的。
 */
const CODE = `E2EAI_${Date.now().toString(36).toUpperCase()}`
let definitionId = ""
let instanceId = ""

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  const { api, dispose } = await createApiClient()
  // 三个方言的种子 ID 不一样，现查
  const users = (await api.get("/api/v1/sys/users?username=liuyang")) as { items: { id: string; username: string }[] }
  const approverId = String(users.items.find((u) => u.username === "liuyang")!.id)
  const form = { schemaVersion: 1, fields: [{ id: "f_reason", type: "text", label: "事由", required: true }] }
  const model = {
    schemaVersion: 1,
    root: {
      type: "start",
      id: "start",
      next: {
        type: "approval",
        id: "n_leader",
        name: "审批人",
        mode: "any",
        assignee: { kind: "user", user_ids: [approverId] },
        onEmpty: "reject",
        fieldPerms: {},
        next: null,
      },
    },
    aiReview: { enabled: true, points: "事由要写清楚具体原因" },
  }
  const created = (await api.post("/api/v1/sys/workflow/definitions", { code: CODE, name: `E2E 预审 ${CODE}`, form, model })) as {
    id: string
  }
  definitionId = created.id
  expect(((await api.post(`/api/v1/sys/workflow/definitions/${definitionId}/publish`)) as { published: boolean }).published).toBe(
    true
  )
  await dispose()

  const ctx = await request.newContext({ baseURL: API_BASE })
  const { token } = await loginToken(ctx, "lina", "123456")
  const res = await ctx.post(`${API_BASE}/api/v1/sys/workflow/instances`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { code: CODE, form: { f_reason: "出差" }, key: `${CODE}-start` },
  })
  instanceId = ((await res.json()) as { data: { instance_id: string } }).data.instance_id
  await ctx.dispose()
})

function fulfillReview(body: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, msg: "ok", data: body }) }
}

test("审批人：有结论时显示建议 + 理由，理由标着字段名", async ({ page }) => {
  await page.route(/\/ai-review$/, (route) =>
    route.fulfill(
      fulfillReview({
        visible: true,
        enabled: true,
        status: "done",
        verdict: "attention",
        reasons: [{ field_id: "f_reason", text: "事由过于笼统" }],
        model: "e2e-model",
        finished_time: new Date().toISOString(),
        superseded: 0,
      })
    )
  )
  await loginPageAs(page, "liuyang", "123456")
  await page.goto(`/workflow/inbox?id=${instanceId}`)
  const panel = page.getByTestId("wf-instance-sheet").getByTestId("wf-ai-review")
  await expect(panel.getByTestId("wf-ai-verdict")).toHaveText("需要留意")
  await expect(panel.getByTestId("wf-ai-reasons")).toContainText("事由")
  await expect(panel.getByTestId("wf-ai-reasons")).toContainText("事由过于笼统")
  await expect(panel).toContainText("e2e-model")
})

test("审批人：失败显示原因 + 重新预审，点了之后变成预审中", async ({ page }) => {
  let state: "failed" | "pending" = "failed"
  let retried = false
  await page.route(/\/ai-review\/retry$/, (route) => {
    retried = true
    state = "pending"
    return route.fulfill(fulfillReview(null))
  })
  await page.route(/\/ai-review$/, (route) =>
    route.fulfill(fulfillReview({ visible: true, enabled: true, status: state, error: "网关 502（E2E 造的）", superseded: 0 }))
  )
  await loginPageAs(page, "liuyang", "123456")
  await page.goto(`/workflow/inbox?id=${instanceId}`)
  const panel = page.getByTestId("wf-instance-sheet").getByTestId("wf-ai-review")
  await expect(panel.getByTestId("wf-ai-failed")).toContainText("网关 502")
  await panel.getByTestId("wf-ai-retry").click()
  await expect(panel.getByTestId("wf-ai-pending")).toBeVisible()
  expect(retried).toBe(true)
})

test("真接口：审批人看得到预审面板（预审中或失败，总之不是没有）", async ({ page }) => {
  await loginPageAs(page, "liuyang", "123456")
  await page.goto(`/workflow/inbox?id=${instanceId}`)
  const sheet = page.getByTestId("wf-instance-sheet")
  await expect(sheet.getByTestId("wf-field-f_reason")).toBeVisible()
  // 没有 worker 时停在预审中；连不上 broker 时当场失败 —— 两种都是可见状态
  await expect(sheet.getByTestId("wf-ai-pending").or(sheet.getByTestId("wf-ai-failed"))).toBeVisible()
})

test("真接口：发起人看不到预审", async ({ page }) => {
  await loginPageAs(page, "lina", "123456")
  await page.goto(`/workflow/inbox?id=${instanceId}`)
  const sheet = page.getByTestId("wf-instance-sheet")
  await expect(sheet.getByTestId("wf-field-f_reason")).toBeVisible()
  await expect(sheet.getByTestId("wf-ai-review")).toHaveCount(0)
})

test("设计器：基础信息里关掉预审，保存后刷新还是关的，要点原文保留", async ({ authedPage: page }) => {
  await page.goto(`/workflow/definition?id=${definitionId}&step=basic`)
  const scope = page.locator('[data-tab="/_auth/workflow/definition"]')
  await expect(scope.getByTestId("wfd-ai-points")).toHaveValue("事由要写清楚具体原因")
  await scope.getByTestId("wfd-ai-enabled").click()
  await expect(scope.getByTestId("wfd-ai-points")).toHaveCount(0)
  await scope.getByTestId("wfd-save").click()
  await expect(scope.getByTestId("wfd-save")).toBeDisabled()

  await page.reload()
  await expect(scope.getByTestId("wfd-ai-enabled")).not.toBeChecked()
  // 重新打开：要点还在，不用重写
  await scope.getByTestId("wfd-ai-enabled").click()
  await expect(scope.getByTestId("wfd-ai-points")).toHaveValue("事由要写清楚具体原因")
})
