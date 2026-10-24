import { expect, test } from "../fixtures/base"

/**
 * 短信（issue #153）：「配置一下就能用」的端到端回归。
 *
 * 用**控制台**厂商（不真发）在界面上走完整条路，顺序是真实的接入顺序「先测再采用」：
 * 新建配置（一个业务模板都不配）→ 发一条测试短信 → 结果块「已受理」→ 点「用这个模板配验证码」→
 * 编辑表单里模板 ID 已填好 → 保存 → 卡片上有了模板 → 再测一条（模板 ID 自动带出）→ 点结果块里的日志链接 →
 * 发送日志页筛到这两条（手机号掩码）→ 详情里是完整号。
 *
 * ⚠️ 定位一律按 routeId 收窄：隐藏 tab 的 DOM 也在文档树里（根 CLAUDE.md 硬纪律 5）。
 */
const CONFIG_PAGE = '[data-tab="/_auth/sms/config"]'
const LOG_PAGE = '[data-tab="/_auth/sms/log"]'
const PHONE = "19900009999"

test.describe("短信配置与发送日志", () => {
  test("建一条控制台配置、测通后一键配上模板、日志里能看到", async ({
    authedPage: page,
    api,
  }) => {
    const name = `E2E短信${Date.now().toString(36)}`
    // 收尾在 finally 里：用例中途红了也要把配置删掉，否则一条启用的 captcha 配置留在 fba_test 里，
    // 后端 `test_disabled_config_is_never_auto_picked` 就会被它顶成假红（实测踩过）
    try {
      await page.goto("/sms/config")
      await page
        .locator(`${CONFIG_PAGE} [data-testid="sms-config-add"]`)
        .click()
      await page.getByTestId("sms-name").fill(name)
      // 厂商下拉默认选第一家（阿里云）；切到控制台
      await page.getByRole("combobox").first().click()
      await page.getByRole("option", { name: /控制台/ }).click()
      await page.getByTestId("sms-sign").fill("E2E签名")
      await page.getByTestId("sms-submit").click()

      const card = page.locator(
        `${CONFIG_PAGE} [data-testid="sms-config-card-${name}"]`
      )
      await expect(card).toBeVisible()
      await expect(card).toContainText("一个都没配")

      // 先测：手填厂商模板 ID，结果块必须说「已受理」；发过之后按钮变成「再发一条」
      await card.getByTestId(`sms-config-test-${name}`).click()
      await page.getByTestId("sms-test-phone").fill(PHONE)
      await expect(page.getByTestId("sms-test-template")).toHaveValue("")
      await page.getByTestId("sms-test-template").fill("DEV_CAPTCHA")
      await page.getByTestId("sms-test-send").click()
      const result = page.getByTestId("sms-test-result")
      await expect(result).toContainText("已受理")
      await expect(page.getByTestId("sms-test-send")).toHaveText(/再发一条/)

      // 再采用：一键带进编辑表单 —— 验证码模板已勾上、模板 ID 已填、变量 code 映射成同名
      await page.getByTestId("sms-test-adopt").click()
      await expect(page.getByTestId("sms-test-dialog")).toBeHidden()
      await expect(page.getByTestId("sms-tpl-id-captcha")).toHaveValue(
        "DEV_CAPTCHA"
      )
      await expect(
        page.getByTestId("sms-tpl-captcha").getByRole("textbox").nth(1)
      ).toHaveValue("code")
      await page.getByTestId("sms-submit").click()
      await expect(card).toContainText("DEV_CAPTCHA")
      await expect(card).not.toContainText("一个都没配")

      // 「今日已发」跟着涨
      await expect(card).toContainText("今日已发")
      await expect(card.getByText(/1 \//)).toBeVisible()

      // 配好之后再测：模板 ID 自动带出；结果块里的日志链接直接跳到筛好的日志页
      await card.getByTestId(`sms-config-test-${name}`).click()
      await page.getByTestId("sms-test-phone").fill(PHONE)
      await expect(page.getByTestId("sms-test-template")).toHaveValue(
        "DEV_CAPTCHA"
      )
      await page.getByTestId("sms-test-send").click()
      await expect(result).toContainText("已受理")
      await page.getByTestId("sms-test-log-link").click()
      await expect(page.getByTestId("sms-test-dialog")).toBeHidden()
      await expect(page).toHaveURL(/\/sms\/log\?.*template=test/)
      // 纯数字的字符串在地址栏里带引号保类型（lib/search-params.ts，硬纪律 6 那条）
      await expect(page).toHaveURL(new RegExp(`phone=(%22)?${PHONE}`))

      // 日志页：掩码行 → 详情完整号
      const table = page.locator(`${LOG_PAGE} [data-testid="sms-log-table"]`)
      await expect(table).toContainText("199****9999")
      await expect(table).not.toContainText(PHONE)
      await expect(table).toContainText("已受理")
      await table.locator('[data-testid^="open-detail-"]').first().click()
      await expect(page.getByRole("dialog")).toContainText(PHONE)
      await page.getByRole("button", { name: "关闭" }).click()
    } finally {
      // 收尾：删掉配置（日志由保留期清理，这里只删自己建的那条）
      const list = (await api.get("/api/v1/sms/configs?page=1&size=50")) as {
        items: { id: string; name: string }[]
      }
      for (const item of list.items.filter((i) => i.name === name)) {
        await api.del(`/api/v1/sms/configs/${item.id}`)
      }
    }
  })
})
