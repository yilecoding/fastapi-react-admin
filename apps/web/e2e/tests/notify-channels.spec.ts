import { expect, test } from "../fixtures/base"

/**
 * 通知渠道路由（#166）：管理端「通知策略」矩阵 + 个人中心「通知偏好」。
 *
 * 两条都是「保存成功、界面没变」那一类会静默坏的：
 * - 策略存进去之后刷新，格子要还是新值（`draft ?? 服务端值` 两层，存完清草稿）
 * - 管理员设成「必发」的格子，个人中心里要是锁 —— 能拨动的话就是一个「显示已关闭、实际照发」的开关
 *
 * 用 `workflow.cc` × 邮件：默认「默认不发，可开」，改成「必发」再改回去，不碰别的用例在用的格子。
 */

const POLICIES = "/api/v1/sys/notification-channels/policies"
const PREFS = "/api/v1/sys/notification-channels/prefs/me"

test.describe("通知渠道路由", () => {
  // 两条都改同一格策略（全局状态），并行会互相踩
  test.describe.configure({ mode: "serial" })

  test.afterEach(async ({ api }) => {
    // 改回默认值 = 删掉那一格（后端 `update_policies`）
    await api.put(POLICIES, { items: [{ kind: "workflow.cc", channel: "email", mode: "default_off" }] })
    await api.put(PREFS, { items: [{ kind: "workflow.task_assigned", channel: "email", enabled: false }] })
  })

  test("策略矩阵：改一格、保存、刷新之后还是新值", async ({ authedPage: page }) => {
    await page.goto("/notify/policy")
    const scope = page.locator('[data-tab="/_auth/notify/policy"]')
    const cell = scope.getByTestId("policy-workflow.cc-email")
    await expect(cell).toContainText("默认不发，可开")

    await cell.click()
    await page.getByRole("option", { name: /^必发/ }).click()
    await expect(scope.getByTestId("policy-save")).toHaveText("保存（1 处）")
    await scope.getByTestId("policy-save").click()
    await expect(page.getByText("通知策略已保存")).toBeVisible()

    await page.reload()
    await expect(scope.getByTestId("policy-workflow.cc-email")).toContainText("必发")
    // 站内那一格永远是「必发」，而且不是下拉（不让改）
    await expect(scope.getByTestId("policy-workflow.cc-inapp")).toHaveCount(0)
  })

  test("个人偏好：能改的格子拨一下就存；管理员设成必发的格子是锁", async ({ authedPage: page, api }) => {
    await api.put(POLICIES, { items: [{ kind: "workflow.cc", channel: "email", mode: "forced" }] })

    await page.goto("/profile?section=notify")
    const scope = page.locator('[data-tab="/_auth/profile"]')
    const assigned = scope.getByTestId("prefs-workflow.task_assigned-email")
    await expect(assigned).not.toBeChecked()
    await assigned.click()
    await expect(assigned).toBeChecked()

    await page.reload()
    await expect(scope.getByTestId("prefs-workflow.task_assigned-email")).toBeChecked()

    // 先断言「有」（这一行渲染出来了），再断言它是锁
    const locked = scope.getByTestId("prefs-workflow.cc-email")
    await expect(locked).toBeVisible()
    await expect(locked).toHaveAttribute("data-locked", "true")
  })
})
