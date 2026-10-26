import { expect, test } from "../fixtures/base"

/**
 * 个人中心绑定手机号（issue #168 第一步）：发码 → 填错一次（可见错误、不绑）→ 填对 → 「已验证」→ 解绑。
 *
 * 用**控制台**厂商：不真发，把渲染后的参数原样回显进 `provider_msg`，所以验证码能从发送日志里读出来 ——
 * 这也是它只在开发环境注册的原因（生产没有这条通道）。
 *
 * ⚠️ 定位按 routeId 收窄（根 CLAUDE.md 硬纪律 5）。admin 在种子里没有手机号，用完解绑还原。
 */
const PROFILE = '[data-tab="/_auth/profile"]'
const PHONE = "19900009988"

test("个人中心：用验证码绑定手机号，绑完显示「已验证」，再解绑", async ({
  authedPage: page,
  api,
}) => {
  const name = `E2E绑号${Date.now().toString(36)}`
  await api.post("/api/v1/sms/configs", {
    name,
    provider: "console",
    sign_name: "E2E签名",
    is_default: true,
    templates: {
      captcha: {
        template_id: "DEV_CAPTCHA",
        mapping: { code: "code", minutes: "minutes" },
      },
    },
  })
  try {
    await page.goto("/profile")
    const block = page.locator(`${PROFILE} [data-testid="profile-phone"]`)
    await expect(block.getByTestId("p-phone-current")).toHaveText("未绑定")

    await block.getByTestId("p-phone").fill(PHONE)
    await block.getByTestId("p-phone-send").click()
    await expect(block.getByTestId("card-ok")).toContainText("验证码已发往")
    // 发过之后按钮进 60 秒倒计时：`captcha` 模板的冷却就是 60 秒，这时再点必拿「操作太频繁」
    await expect(block.getByTestId("p-phone-send")).toBeDisabled()
    await expect(block.getByTestId("p-phone-send")).toContainText("秒后可重发")

    // 从发送日志里拿码：控制台厂商把参数原样回显进 provider_msg
    const logs = (await api.get(
      `/api/v1/sms/logs?phone=${PHONE}&template=captcha&page=1&size=5`
    )) as {
      items: { provider_msg: string | null }[]
    }
    const code = /'code': '(\d{6})'/.exec(
      logs.items[0]?.provider_msg ?? ""
    )?.[1]
    expect(code, JSON.stringify(logs.items[0])).toBeTruthy()

    // 填错一次：错误要显示出来，当前号不变（硬纪律 9）
    await block
      .getByTestId("p-phone-captcha")
      .fill(code === "000000" ? "111111" : "000000")
    await block.getByTestId("p-phone-save").click()
    await expect(block.getByTestId("card-error")).toBeVisible()
    await expect(block.getByTestId("p-phone-current")).toHaveText("未绑定")

    // 填对：绑上，并且是「已验证」（本人用验证码绑的，不是管理员录的）
    await block.getByTestId("p-phone-captcha").fill(code as string)
    await block.getByTestId("p-phone-save").click()
    await expect(block.getByTestId("p-phone-current")).toHaveText(PHONE)
    await expect(block.getByTestId("p-phone-verified")).toContainText("已验证")

    // 解绑：号码和验证状态一起没了
    await block.getByTestId("p-phone-unbind").click()
    await expect(block.getByTestId("p-phone-current")).toHaveText("未绑定")
    await expect(block.getByTestId("p-phone-verified")).toHaveCount(0)
  } finally {
    // 收尾在 finally：中途红了也要把 admin 的号解掉、把配置删掉（sms.spec.ts 踩过留一条启用配置把后端测试顶红）
    await api.del("/api/v1/sys/users/me/phone").catch(() => undefined)
    const list = (await api.get("/api/v1/sms/configs?page=1&size=50")) as {
      items: { id: string; name: string }[]
    }
    for (const item of list.items.filter((i) => i.name === name)) {
      await api.del(`/api/v1/sms/configs/${item.id}`)
    }
  }
})
