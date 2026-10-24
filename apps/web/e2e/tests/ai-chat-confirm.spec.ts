import { expect, loginPageAs, test } from "../fixtures/base"

/**
 * AI 对话里的写操作确认卡片：点了「确认执行」之后，卡片要换成结果。
 *
 * 🔴 本地真跑（2026-10-24，真模型对话里审批）时看到的：确认成功、单子已经通过了，卡片却原样留着、按钮又能点了 ——
 * 再点一次只会拿到「已过期」（令牌是一次性的），看起来像「刚才没执行」。所有写工具（部门 / 角色 / 菜单 / 审批）都是这样。
 *
 * E2E 没有模型：对话和确认两个 SSE 接口用 `page.route` 固定返回，验的是卡片的状态。
 */
function sse(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
}

const PROPOSE = sse([
  { type: "tool_result", call_id: "c1", name: "wf_todo_list", ok: true, summary: "1 张", perm: null, duration_ms: 12 },
  {
    type: "confirm_required",
    token: "cf_e2e",
    name: "wf_approve",
    preview: "将以你本人的身份同意「孙强提交的演示」，意见：「核对无误」",
    arguments: { instance_id: "1" },
  },
  { type: "done" },
])

async function propose(page: import("@playwright/test").Page) {
  // ⚠️ 要慢一点：瞬间返回的话，新会话的历史（空的）在流结束之后才回来，把气泡整个盖掉。
  // 本地真跑时模型要好几秒、历史早就回来了，没撞到；模型比历史请求还快时会不会撞上，没有实测过
  await page.route("**/api/v1/ai/chat/stream", async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: PROPOSE })
  })
  await loginPageAs(page, "admin", "123456")
  await page.goto("/ai/chat")
  const box = page.getByPlaceholder("问点什么…")
  await box.fill("把孙强那张同意了，意见写「核对无误」")
  await box.press("Enter")
  await expect(page.getByTestId("ai-confirm")).toBeVisible()
}

test("确认成功：卡片换成「已执行」，按钮没了", async ({ page }) => {
  await page.route("**/api/v1/ai/chat/tools/confirm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "tool_result", call_id: "c2", name: "wf_approve", ok: true, summary: "已同意", perm: null, duration_ms: 30 },
        { type: "done" },
      ]),
    })
  )
  await propose(page)
  await page.getByTestId("ai-confirm").click()
  await expect(page.getByTestId("ai-confirm-done")).toBeVisible()
  await expect(page.getByTestId("ai-confirm")).toHaveCount(0)
})

test("确认失败（令牌过期）：卡片说没执行成功，不再给一个点了也没用的按钮", async ({ page }) => {
  await page.route("**/api/v1/ai/chat/tools/confirm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([{ type: "error", message: "这个确认已经过期或处理过了", code: "confirm_expired" }]),
    })
  )
  await propose(page)
  await page.getByTestId("ai-confirm").click()
  await expect(page.getByTestId("ai-confirm-failed")).toBeVisible()
  await expect(page.getByText("这个确认已经过期或处理过了")).toBeVisible()
  await expect(page.getByTestId("ai-confirm")).toHaveCount(0)
})
