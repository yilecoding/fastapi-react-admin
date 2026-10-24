import { expect, loginPageAs, test } from "../fixtures/base"

/**
 * 对话按人限流（`AI_CHAT_RATE_PER_MINUTE`）：超了后端在开始流之前回 429。
 * 前端要说「发得太快了」，不能说「请求失败（HTTP 429）」—— 后者读起来像系统坏了。
 *
 * E2E 没有模型：对话接口用 `page.route` 固定回 429，验的是提示文案。
 */
test("对话发得太快：说清楚要等多久，不说「请求失败」", async ({ page }) => {
  // ⚠️ 要慢一点：瞬间返回的话，新会话的历史（空的）后到，把气泡整个盖掉（同 ai-chat-confirm.spec.ts）
  await page.route("**/api/v1/ai/chat/stream", async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    // 跨源时 JS 只读得到暴露了的头：后端在 `CORS_EXPOSE_HEADERS` 里列了它（pytest 守着），假接口照样带上
    await route.fulfill({
      status: 429,
      headers: { "Retry-After": "42", "Access-Control-Expose-Headers": "Retry-After" },
      body: "{}",
    })
  })
  await loginPageAs(page, "admin", "123456")
  await page.goto("/ai/chat")
  const box = page.getByPlaceholder("问点什么…")
  await box.fill("你好")
  await box.press("Enter")
  await expect(page.getByText("发得太快了，请 42 秒后再发")).toBeVisible()
  await expect(page.getByText("请求失败（HTTP 429）")).toHaveCount(0)
})
