import type { Page } from "@playwright/test"

import { expect, loginPageAs, test } from "../fixtures/base"

/**
 * AI 对话的流式发送（#329）。E2E 没有模型：会话列表 / 历史 / 对话流全用 `page.route` 固定返回。
 *
 * 1. 流式途中切会话：原来流式期间一律挡住历史覆盖，界面停在「选中 B、显示 A 的全文」，
 *    再发一句就带着 `conversation_id: B` 发出去了
 * 2. `fetch` 直接 reject（断网 / 流中途断开）：原来 `send` 没有 catch，气泡永远「思考中」，什么提示都没有
 * 3. 确认流途中切会话（#372）：确认流原来按「最后一条助手气泡」落事件，结果和报错写进了乙的气泡
 */
function sse(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")
}

const ok = (data: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, msg: "ok", data }) })

const conv = (id: string, title: string) => ({
  id,
  title,
  provider_id: null,
  created_time: "2026-11-16T10:00:00+08:00",
  updated_time: null,
})

const history = (id: string, user: string, answer: string) => [
  { id: `${id}-1`, role: "user", content: user, tool_calls: null, created_time: "2026-11-16T10:00:00+08:00" },
  { id: `${id}-2`, role: "assistant", content: answer, tool_calls: null, created_time: "2026-11-16T10:00:01+08:00" },
]

async function mockConversations(page: Page, aHistory = history("a", "甲的旧问题", "甲的旧回答")) {
  await page.route((url) => url.pathname.endsWith("/api/v1/ai/conversations"), (route) =>
    route.fulfill(
      ok({
        items: [conv("9001", "会话甲"), conv("9002", "会话乙")],
        total: 2,
        page: 1,
        size: 50,
        total_pages: 1,
        links: { first: "", last: "", next: null, prev: null },
      })
    )
  )
  await page.route("**/api/v1/ai/conversations/*/messages", (route) => {
    const isB = route.request().url().includes("/9002/")
    return route.fulfill(ok(isB ? history("b", "乙的旧问题", "乙的旧回答") : aHistory))
  })
}

async function sendIn(page: Page, conversationId: string, text: string) {
  await loginPageAs(page, "admin", "123456")
  await page.goto(`/ai/chat?c=${conversationId}`)
  await expect(page.getByText("甲的旧回答")).toBeVisible()
  const box = page.getByPlaceholder("问点什么…")
  await box.fill(text)
  await box.press("Enter")
  await expect(page.getByText(text)).toBeVisible()
}

test("流式途中切到另一个会话：显示那个会话的历史，甲的流不会写进来", async ({ page }) => {
  let release: () => void = () => {}
  const held = new Promise<void>((r) => (release = r))
  await mockConversations(page)
  await page.route("**/api/v1/ai/chat/stream", async (route) => {
    await held
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([{ type: "delta", text: "甲的新回答" }, { type: "done", message_id: null }]),
    })
  })

  await sendIn(page, "9001", "甲的新问题")
  await page.getByRole("button", { name: "会话乙" }).first().click()

  // 换成乙的历史，甲的气泡不能留着
  await expect(page.getByText("乙的旧回答")).toBeVisible()
  await expect(page.getByText("甲的新问题")).toHaveCount(0)

  // 甲的流这时才结束：它的事件要丢弃，不能写进乙的气泡
  const finished = page.waitForResponse("**/api/v1/ai/chat/stream")
  release()
  await finished
  // 给那几帧事件一个落地的机会：要错也是这时候错
  await page.waitForTimeout(500)
  await expect(page.getByText("甲的新回答")).toHaveCount(0)
  await expect(page.getByText("乙的旧回答")).toBeVisible()
})

test("连接断了（fetch 直接失败）：气泡说清楚，不会一直「思考中」", async ({ page }) => {
  await mockConversations(page)
  await page.route("**/api/v1/ai/chat/stream", async (route) => {
    await new Promise((r) => setTimeout(r, 500))
    await route.abort("internetdisconnected")
  })

  await sendIn(page, "9001", "甲的新问题")
  await expect(page.getByText("连接断了，请检查网络后重新发送")).toBeVisible()
})

test("流正常关了却没收到 done：pending 落下，并说回答可能不完整", async ({ page }) => {
  await mockConversations(page)
  await page.route("**/api/v1/ai/chat/stream", async (route) => {
    await new Promise((r) => setTimeout(r, 500))
    await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse([{ type: "delta", text: "说到一半" }]) })
  })

  await sendIn(page, "9001", "甲的新问题")
  await expect(page.getByText("连接中途断开，回答可能不完整")).toBeVisible()
})

test("确认途中切到另一个会话：确认流的结果不落到那个会话的气泡上（#372）", async ({ page }) => {
  let release: () => void = () => {}
  const held = new Promise<void>((r) => (release = r))
  const card = [{ kind: "confirm", token: "cf_e2e_switch", name: "dept_create", preview: "将新建部门「研发部」", outcome: null }]
  await mockConversations(page, [
    { id: "a-1", role: "user", content: "建个研发部", tool_calls: null, created_time: "2026-11-16T10:00:00+08:00" },
    { id: "a-2", role: "assistant", content: "甲的旧回答", tool_calls: JSON.stringify(card), created_time: "2026-11-16T10:00:01+08:00" },
  ])
  await page.route("**/api/v1/ai/chat/tools/confirm", async (route) => {
    await held
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: sse([
        { type: "tool_result", call_id: "c1", name: "dept_create", ok: false, summary: "dept_create 执行失败", perm: null, duration_ms: 9, detail: "确认流的失败原因" },
        { type: "error", message: "确认流的报错", code: "tool_failed" },
      ]),
    })
  })

  await loginPageAs(page, "admin", "123456")
  await page.goto("/ai/chat?c=9001")
  await page.getByTestId("ai-confirm").click()
  await page.getByRole("button", { name: "会话乙" }).first().click()
  await expect(page.getByText("乙的旧回答")).toBeVisible()

  const finished = page.waitForResponse("**/api/v1/ai/chat/tools/confirm")
  release()
  await finished
  await page.waitForTimeout(500)
  await expect(page.getByText("确认流的报错")).toHaveCount(0)
  await expect(page.getByText("乙的旧回答")).toBeVisible()
})
