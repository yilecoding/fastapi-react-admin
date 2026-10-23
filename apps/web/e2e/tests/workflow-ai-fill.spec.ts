import { createApiClient, expect, loginPageAs, test } from "../fixtures/base"

/**
 * 发起页「AI 帮我填」（#111 第 3 条）的界面。
 *
 * 后端的把关（只给发起人能填的字段 / 逐个值校验 / 材料只进 user 消息 / 调用记录）在 pytest 里（`test_ai_fill.py`），
 * 真模型在 `test_ai_fill_real_model.py`。E2E 没有模型，填单接口用 `page.route` 固定返回 —— 这里验的是：
 * **只填还空着的字段**、标「AI 填的」、**没核对不许提交**、标记跟着草稿存（关掉再打开还在）、失败挂在面板里。
 *
 * 账号用 zhoumin（发起）/ zhangwei（审批）：别的 spec 没在用（e2e 分册「两个 spec 文件不要登同一个演示账号」）。
 */
const CODE = `E2EAIF_${Date.now().toString(36).toUpperCase()}`

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  const { api, dispose } = await createApiClient()
  const users = (await api.get("/api/v1/sys/users?username=zhangwei")) as { items: { id: string; username: string }[] }
  const approverId = String(users.items.find((u) => u.username === "zhangwei")!.id)
  const form = {
    schemaVersion: 1,
    fields: [
      { id: "f_reason", type: "text", label: "事由", required: true },
      { id: "f_amount", type: "amount", label: "金额", precision: 2 },
      { id: "f_dest", type: "text", label: "目的地" },
    ],
  }
  const model = {
    schemaVersion: 1,
    root: {
      type: "start",
      id: "start",
      next: {
        type: "approval",
        id: "n1",
        name: "审批",
        mode: "any",
        assignee: { kind: "user", user_ids: [approverId] },
        onEmpty: "reject",
        fieldPerms: {},
        next: null,
      },
    },
  }
  const created = (await api.post("/api/v1/sys/workflow/definitions", { code: CODE, name: `E2E 填单 ${CODE}`, form, model })) as {
    id: string
  }
  expect(((await api.post(`/api/v1/sys/workflow/definitions/${created.id}/publish`)) as { published: boolean }).published).toBe(true)
  await dispose()
})

const FILLED = {
  values: { f_reason: "去上海见客户", f_amount: "553.00", f_dest: "上海" },
  skipped: [],
  note: null,
  model_name: "fake-vl",
}

async function openStart(page: import("@playwright/test").Page) {
  await loginPageAs(page, "zhoumin", "123456")
  await page.goto(`/workflow/inbox?start=${CODE}`)
  await expect(page.getByTestId("wf-start-title")).toBeVisible()
}

function field(page: import("@playwright/test").Page, id: string) {
  return page.getByTestId(`wf-field-${id}`).locator("input")
}

test("只填还空着的字段、标「AI 填的」；没核对不许提交；标记跟着草稿存", async ({ page }) => {
  await page.route(`**/api/v1/sys/workflow/startable/${CODE}/ai-fill`, (route) =>
    route.fulfill({ json: { code: 200, msg: "请求成功", data: FILLED } })
  )
  await openStart(page)
  // 目的地自己先填了：AI 不能替他改
  await field(page, "f_dest").fill("杭州")
  await page.getByTestId("wf-ai-fill-toggle").click()
  await page.getByTestId("wf-ai-fill-text").fill("下周一去上海见客户，车票 553 元")
  await page.getByTestId("wf-ai-fill-submit").click()

  await expect(page.getByTestId("wf-ai-fill-summary")).toContainText("填了 2 项")
  await expect(page.getByTestId("wf-ai-fill-summary")).toContainText("已经有内容的 1 项没动")
  await expect(field(page, "f_reason")).toHaveValue("去上海见客户")
  await expect(field(page, "f_dest")).toHaveValue("杭州")
  await expect(page.getByTestId("wf-ai-mark")).toHaveCount(2)

  // 关掉再打开：值和标记都还在（草稿存了 ai_filled）
  await expect(page.getByTestId("wf-draft-status")).toContainText("草稿已保存")
  await page.reload()
  await expect(page.getByTestId("wf-start-title")).toBeVisible()
  await expect(field(page, "f_reason")).toHaveValue("去上海见客户")
  await expect(page.getByTestId("wf-ai-mark")).toHaveCount(2)

  // 没核对：提交被拦，那两个字段下面说清楚
  await page.getByTestId("wf-start-submit").click()
  await expect(page.getByTestId("wf-field-f_reason").locator("..")).toContainText("核对无误后点「没问题」")
  await expect(page).toHaveURL(new RegExp(`start=${CODE}`))

  // 一个点「没问题」，一个自己改：标记都没了，能提交
  await page.getByTestId("wf-field-f_reason").locator("..").getByRole("button", { name: "没问题" }).click()
  await field(page, "f_amount").fill("560")
  await expect(page.getByTestId("wf-ai-mark")).toHaveCount(0)
  await page.getByTestId("wf-start-submit").click()
  await expect(page).toHaveURL(/id=\d+/)
})

test("填单失败：错误挂在面板里，材料还在", async ({ page }) => {
  await page.route(`**/api/v1/sys/workflow/startable/${CODE}/ai-fill`, (route) =>
    route.fulfill({
      status: 400,
      json: { code: 400, msg: "AI 没能填单，表单没有改动。原因：模型什么都没返回 —— 材料是图片，当前的模型可能看不了图", data: null },
    })
  )
  await openStart(page)
  await page.getByTestId("wf-ai-fill-toggle").click()
  await page.getByTestId("wf-ai-fill-text").fill("见客户")
  await page.getByTestId("wf-ai-fill-submit").click()
  await expect(page.getByTestId("wf-ai-fill-error")).toContainText("看不了图")
  await expect(page.getByTestId("wf-ai-fill-text")).toHaveValue("见客户")
  await expect(page.getByTestId("wf-ai-mark")).toHaveCount(0)
})
