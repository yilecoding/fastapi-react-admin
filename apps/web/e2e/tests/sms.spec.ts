import { expect, test } from "../fixtures/base"

/**
 * 短信（issue #153）：「配置一下就能用」的端到端回归。
 *
 * 用**控制台**厂商（不真发）在界面上走完整条路：新建配置 → 勾上验证码模板 → 保存 → 发一条测试短信 →
 * 结果块显示「已受理」→ 发送日志页出现那一条（手机号掩码）→ 详情里是完整号。
 *
 * ⚠️ 定位一律按 routeId 收窄：隐藏 tab 的 DOM 也在文档树里（根 CLAUDE.md 硬纪律 5）。
 */
const CONFIG_PAGE = '[data-tab="/_auth/sms/config"]'
const LOG_PAGE = '[data-tab="/_auth/sms/log"]'
const PHONE = "19900009999"

test.describe("短信配置与发送日志", () => {
  test("建一条控制台配置、发测试短信、日志里能看到", async ({ authedPage: page, api }) => {
    const name = `E2E短信${Date.now().toString(36)}`

    await page.goto("/sms/config")
    await page.locator(`${CONFIG_PAGE} [data-testid="sms-config-add"]`).click()
    await page.getByTestId("sms-name").fill(name)
    // 厂商下拉默认选第一家（阿里云）；切到控制台
    await page.getByRole("combobox").first().click()
    await page.getByRole("option", { name: /控制台/ }).click()
    await page.getByTestId("sms-sign").fill("E2E签名")
    await page.getByTestId("sms-tpl-enable-captcha").click()
    await page.getByTestId("sms-tpl-id-captcha").fill("DEV_CAPTCHA")
    await page.getByTestId("sms-submit").click()

    const card = page.locator(`${CONFIG_PAGE} [data-testid="sms-config-card-${name}"]`)
    await expect(card).toBeVisible()
    await expect(card).toContainText("DEV_CAPTCHA")

    // 发测试短信：结果块必须说「已受理」，并带日志 ID
    await card.getByTestId(`sms-config-test-${name}`).click()
    await page.getByTestId("sms-test-phone").fill(PHONE)
    await expect(page.getByTestId("sms-test-template")).toHaveValue("DEV_CAPTCHA")
    await page.getByTestId("sms-test-send").click()
    const result = page.getByTestId("sms-test-result")
    await expect(result).toContainText("已受理")
    await page.getByRole("button", { name: "关闭" }).click()

    // 「今日已发」跟着涨
    await expect(card).toContainText("今日已发")
    await expect(card.getByText(/1 \//)).toBeVisible()

    // 日志页：掩码行 → 详情完整号
    await page.goto(`/sms/log?phone=${PHONE}`)
    const table = page.locator(`${LOG_PAGE} [data-testid="sms-log-table"]`)
    await expect(table).toContainText("199****9999")
    await expect(table).not.toContainText(PHONE)
    await expect(table).toContainText("已受理")
    await table.locator('[data-testid^="open-detail-"]').first().click()
    await expect(page.getByRole("dialog")).toContainText(PHONE)
    await page.getByRole("button", { name: "关闭" }).click()

    // 收尾：删掉配置（日志由保留期清理，这里只删自己建的那条）
    const list = (await api.get("/api/v1/sms/configs?page=1&size=50")) as { items: { id: string; name: string }[] }
    for (const item of list.items.filter((i) => i.name === name)) {
      await api.del(`/api/v1/sms/configs/${item.id}`)
    }
  })
})
