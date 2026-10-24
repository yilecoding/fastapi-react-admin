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

test("执行失败：卡片说没执行成功，不再给一个点了也没用的按钮", async ({ page }) => {
  await page.route("**/api/v1/ai/chat/tools/confirm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "tool_result", call_id: "c2", name: "wf_approve", ok: false, summary: "wf_approve 执行失败", perm: null, duration_ms: 30 },
        { type: "done" },
      ]),
    })
  )
  await propose(page)
  await page.getByTestId("ai-confirm").click()
  await expect(page.getByTestId("ai-confirm-failed")).toBeVisible()
  await expect(page.getByTestId("ai-confirm")).toHaveCount(0)
})

test("令牌用过了 / 过期了：不说「没执行」（可能别处已经执行过），按钮也没了", async ({ page }) => {
  await page.route("**/api/v1/ai/chat/tools/confirm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([{ type: "error", message: "这个确认已经过期或处理过了", code: "confirm_expired" }]),
    })
  )
  await propose(page)
  await page.getByTestId("ai-confirm").click()
  await expect(page.getByTestId("ai-confirm-expired")).toBeVisible()
  await expect(page.getByText("这个确认已经过期或处理过了")).toBeVisible()
  await expect(page.getByTestId("ai-confirm")).toHaveCount(0)
})

/**
 * 🔴 请求没送到：令牌还没动过。原来一律记成「没执行成功」、按钮没了 —— 只能让 AI 重新发起一次。
 * 现在按钮留着、说一句为什么，再点一次就能成（第一次断网、第二次 502、第三次成功）
 */
test("没送到（断网 / 网关 502）：按钮留着，再点一次就能执行", async ({ page }) => {
  let calls = 0
  await page.route("**/api/v1/ai/chat/tools/confirm", (route) => {
    calls += 1
    if (calls === 1) return route.abort("internetdisconnected")
    if (calls === 2) return route.fulfill({ status: 502, body: "Bad Gateway" })
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "tool_result", call_id: "c2", name: "wf_approve", ok: true, summary: "已同意", perm: null, duration_ms: 30 },
        { type: "done" },
      ]),
    })
  })
  await propose(page)
  const confirm = page.getByTestId("ai-confirm")

  await confirm.click()
  await expect(page.getByText("连接断了，可以再点一次确认")).toBeVisible()
  await expect(confirm).toBeEnabled()
  await expect(page.getByTestId("ai-confirm-failed")).toHaveCount(0)

  await confirm.click()
  await expect(page.getByText("请求失败（HTTP 502）")).toBeVisible()
  await expect(confirm).toBeEnabled()

  await confirm.click()
  await expect(page.getByTestId("ai-confirm-done")).toBeVisible()
  expect(calls).toBe(3)
})
