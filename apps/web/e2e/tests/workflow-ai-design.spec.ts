import { createApiClient, expect, loginPageAs, test } from "../fixtures/base"

/**
 * 设计器「一句话生成」（#111 第 1 条）的界面。
 *
 * 后端的把关（形状 / 发布校验 / 回喂一轮 / 丢掉编出来的角色 / 调用记录）在 pytest 里（`test_ai_design.py`），
 * 真模型在 `test_ai_design_real_model.py`。E2E 环境没有模型，生成接口用 `page.route` 固定返回 ——
 * 这里验的是**结果只进草稿**（服务端草稿不变、基础信息和 AI 预审设置不被换掉）、问题能定位、
 * 失败挂在弹窗里、中途关掉弹窗就不要那次结果。
 */
const CODE = `E2EAID_${Date.now().toString(36).toUpperCase()}`
const ORIGINAL = { schemaVersion: 1, fields: [{ id: "f_old", type: "text", label: "原来的字段" }] }
let definitionId = ""

const GENERATED = {
  form: {
    schemaVersion: 1,
    fields: [
      {
        id: "items",
        type: "table",
        label: "物品明细",
        columns: [
          { id: "name", type: "text", label: "名称" },
          { id: "amount", type: "amount", label: "金额", precision: 2 },
        ],
      },
      { id: "total", type: "amount", label: "合计", precision: 2, calc: { kind: "sum", field: "items", column: "amount" } },
    ],
  },
  model: {
    schemaVersion: 1,
    root: {
      type: "start",
      id: "start",
      next: { type: "approval", id: "cfo", name: "财务总监", assignee: null },
    },
  },
  issues: [{ level: "ERROR", code: "APPROVER_EMPTY", message: "「财务总监」没配审批人", nodeId: "cfo" }],
  model_name: "fake-model",
  rounds: 1,
}

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  const { api, dispose } = await createApiClient()
  const model = {
    schemaVersion: 1,
    root: { type: "start", id: "start", next: null },
    aiReview: { enabled: true, points: "事由要写清楚" },
  }
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code: CODE,
    name: `E2E 生成 ${CODE}`,
    form: ORIGINAL,
    model,
  })) as { id: string }
  definitionId = created.id
  await dispose()
})

function generateRoute() {
  return `**/api/v1/sys/workflow/definitions/${definitionId}/ai-generate`
}

async function openDialog(page: import("@playwright/test").Page) {
  await loginPageAs(page, "admin", "123456")
  await page.goto(`/workflow/definition?id=${definitionId}&step=basic`)
  const scope = page.locator('[data-tab="/_auth/workflow/definition"]')
  await scope.getByTestId("wfd-ai-open").click()
  await page.getByTestId("wfd-ai-prompt").fill("做一个采购申请，合计自动算，超过 1 万走财务总监")
  return scope
}

test("生成的结果只进草稿：表单 / 流程换掉、AI 预审设置不动、问题点一下定位，服务端草稿不变", async ({ page }) => {
  await page.route(generateRoute(), (route) =>
    route.fulfill({ json: { code: 200, msg: "请求成功", data: GENERATED } })
  )
  const scope = await openDialog(page)
  // 现在的表单里有东西：要先说清楚会被替换
  await expect(page.getByTestId("wfd-ai-replaces")).toBeVisible()
  await page.getByTestId("wfd-ai-submit").click()

  await expect(page.getByTestId("wfd-ai-dialog")).toHaveCount(0)
  await expect(page).toHaveURL(/step=form/)
  await expect(scope.getByTestId("fd-field-items")).toBeVisible()
  await expect(scope.getByTestId("fd-field-f_old")).toHaveCount(0)
  await expect(scope.getByTestId("wfd-dirty")).toBeVisible()

  await scope.getByTestId("wfd-issues").getByRole("button", { name: /APPROVER_EMPTY/ }).click()
  await expect(page).toHaveURL(/step=flow/)
  await expect(page).toHaveURL(/sel=cfo/)
  await expect(scope.getByTestId("node-name")).toHaveValue("财务总监")

  // 基础信息里管理员定的 AI 预审不被生成结果换掉
  await scope.getByTestId("wfd-step-basic").click()
  await expect(scope.getByTestId("wfd-ai-points")).toHaveValue("事由要写清楚")

  // 没点保存：服务端的草稿还是原来那份
  const { api, dispose } = await createApiClient()
  const d = (await api.get(`/api/v1/sys/workflow/definitions/${definitionId}`)) as { form: typeof ORIGINAL }
  await dispose()
  expect(d.form.fields.map((f) => f.id)).toEqual(["f_old"])
})

test("生成失败：错误挂在弹窗里，描述还在，可以重试", async ({ page }) => {
  let calls = 0
  await page.route(generateRoute(), (route) => {
    calls += 1
    return route.fulfill({
      status: 400,
      json: { code: 400, msg: "AI 没能生成可用的流程定义，你的设计没有改动。原因：模型太久没有返回", data: null },
    })
  })
  await openDialog(page)
  await page.getByTestId("wfd-ai-submit").click()
  await expect(page.getByTestId("wfd-ai-error")).toContainText("模型太久没有返回")
  await expect(page.getByTestId("wfd-ai-prompt")).toHaveValue(/采购申请/)
  await page.getByTestId("wfd-ai-error").getByRole("button").first().click()
  await expect.poll(() => calls).toBe(2)
})

test("生成中关掉弹窗：不要这次的结果（人可能已经接着手动改了）", async ({ page }) => {
  let answered = false
  await page.route(generateRoute(), async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    answered = true
    await route.fulfill({ json: { code: 200, msg: "请求成功", data: GENERATED } })
  })
  const scope = await openDialog(page)
  await page.getByTestId("wfd-ai-submit").click()
  await page.getByTestId("wfd-ai-dialog").getByRole("button", { name: "取消" }).click()
  await expect.poll(() => answered, { timeout: 5000 }).toBe(true)
  await page.waitForTimeout(300)
  await scope.getByTestId("wfd-step-form").click()
  await expect(scope.getByTestId("fd-field-f_old")).toBeVisible()
  await expect(scope.getByTestId("fd-field-items")).toHaveCount(0)
  await expect(scope.getByTestId("wfd-dirty")).toHaveCount(0)
})
