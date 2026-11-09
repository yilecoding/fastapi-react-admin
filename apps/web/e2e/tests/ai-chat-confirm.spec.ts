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

/**
 * 🔴 卡片要能从**历史**里还原（2026-11-06 本地真跑，假模型）。
 *
 * 流一结束前端就重拉历史并整体替换气泡。原来后端只在「有正文」时落库、也只存执行轨迹，
 * 模型调写工具时一个字不说 → 历史里没有这张卡片 → 卡片一闪就没，网页上的写操作**一个都确认不了**。
 * 上面几条没撞上，是因为它们只 mock 了流、历史接口两次都回空数组：react-query 的结构共享让
 * 引用不变，冲刷历史的那个 effect 根本没跑。真实环境里历史多了一条用户消息，引用一变就冲掉了。
 *
 * 这里让历史接口回「新后端落库的样子」（`tool_calls` 里带 `kind: confirm`），而且每次内容都不同
 */
function historyWith(items: object[], userText = "建个部门") {
  return JSON.stringify({
    code: 200,
    msg: "ok",
    data: [
      { id: "1", role: "user", content: userText, tool_calls: null, created_time: "2026-11-06T10:00:00+08:00" },
      { id: "2", role: "assistant", content: "", tool_calls: JSON.stringify(items), created_time: "2026-11-06T10:00:01+08:00" },
    ],
  })
}

const CARD = { kind: "confirm", token: "cf_hist", name: "dept_create", preview: "将在顶级新建部门「AI测试部」" }

test("流结束后重拉历史：确认卡片还在，而且能点", async ({ page }) => {
  let streamed = false
  await page.route("**/api/v1/ai/conversations/*/messages", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      // 那条轨迹只在历史里有（流里没发）：看见它 = 历史已经替换过气泡了，再断言卡片才不是在抢时序
      body: streamed
        ? historyWith([{ name: "dept_list", ok: true, perm: "sys:dept:list", duration_ms: 5 }, { ...CARD, outcome: null }])
        : JSON.stringify({ code: 200, msg: "ok", data: [] }),
    })
  )
  await page.route("**/api/v1/ai/chat/stream", (route) => {
    streamed = true
    return route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([{ type: "confirm_required", ...CARD, arguments: {} }, { type: "done" }]),
    })
  })
  await page.route("**/api/v1/ai/chat/tools/confirm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "tool_result", call_id: "c", name: "dept_create", ok: false, summary: "失败", perm: null, duration_ms: 1, detail: "同级已有同名部门" },
        { type: "done" },
      ]),
    })
  )
  await loginPageAs(page, "admin", "123456")
  await page.goto("/ai/chat")
  const box = page.getByPlaceholder("问点什么…")
  await box.fill("建个部门")
  await box.press("Enter")

  // 等历史真的替换过气泡（那一刻正是原来卡片消失的时候）
  await expect(page.getByText("dept_list")).toBeVisible()
  await expect(page.getByText("将在顶级新建部门「AI测试部」")).toBeVisible()
  await page.getByTestId("ai-confirm").click()
  // 确认那条路上没有模型来转述结果：失败原因要写在卡片上
  await expect(page.getByTestId("ai-confirm-failed")).toContainText("同级已有同名部门")
})

test("刷新之后：已执行的卡片显示结果、不再给按钮；这一轮的报错也还在", async ({ page }) => {
  await page.route("**/api/v1/ai/conversations/*/messages", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: historyWith([
        { name: "dept_list", ok: true, perm: "sys:dept:list", duration_ms: 5 },
        { ...CARD, outcome: "done" },
        { kind: "error", message: "已达到单轮最多 5 次工具调用的上限", code: "max_rounds" },
      ]),
    })
  )
  await loginPageAs(page, "admin", "123456")
  await page.goto("/ai/chat?c=2229935699371491328")
  await expect(page.getByTestId("ai-confirm-done")).toBeVisible()
  await expect(page.getByTestId("ai-confirm")).toHaveCount(0)
  await expect(page.getByText("已达到单轮最多 5 次工具调用的上限")).toBeVisible()
  await expect(page.getByText("dept_list")).toBeVisible()
})
