import { expect, test } from "../fixtures/base"

/**
 * 手机验证码登录（issue #168 第二步）。
 *
 * 控制台厂商不真发，把渲染后的参数回显进发送日志的 `provider_msg`，验证码从那里读（同 profile-phone.spec.ts）。
 * E2E 环境图形验证码是关的（global-setup），发码不用过图形验证码。
 *
 * 守两条：
 * - 没绑过的号：发码接口照样说「已发送」，登录被拒，文案和码错一致（防号码枚举）
 * - 绑过（已验证）的号：能登进来
 *
 * ⚠️ `captcha` 业务模板同一个号 60 秒冷却：先用 API 绑号那次发了一条，登录页再给同一个号发码要等冷却过去。
 * 所以绑号放最前面，中间跑没绑过的号那一段，最后轮询到能发为止 —— 整条用例约一分钟，是冷却决定的，不是慢。
 */
const PHONE = "19900009977"
const PHONE_UNBOUND = "19900009966"

test("登录页：手机验证码登录", async ({ page, api }) => {
  // 要等 `captcha` 模板的 60 秒冷却（见头注释），默认 30 秒的用例超时不够
  test.setTimeout(150_000)
  const name = `E2E手机登录${Date.now().toString(36)}`
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
  const codeFor = async (phone: string): Promise<string> => {
    const logs = (await api.get(
      `/api/v1/sms/logs?phone=${phone}&template=captcha&page=1&size=5`
    )) as {
      items: { provider_msg: string | null }[]
    }
    const code = /'code': '(\d{6})'/.exec(
      logs.items[0]?.provider_msg ?? ""
    )?.[1]
    expect(code, JSON.stringify(logs.items[0])).toBeTruthy()
    return code as string
  }
  try {
    // 1. 用 API 把 admin 的号绑成「已验证」（这是手机登录的前提）
    await api.post("/api/v1/sys/users/me/phone/captcha", { phone: PHONE })
    await api.put("/api/v1/sys/users/me/phone", {
      phone: PHONE,
      captcha: await codeFor(PHONE),
    })

    // 2. 没绑过的号：发码「成功」、登录被拒，文案和码错一样
    await page.goto("/sign-in")
    await page.getByTestId("method-phone").click()
    await page.getByTestId("phone").fill(PHONE_UNBOUND)
    await page.getByTestId("sms-send").click()
    await expect(page.getByTestId("sms-sent")).toBeVisible()
    await expect(page.getByTestId("sms-send")).toBeDisabled()
    await page.getByTestId("sms-code").fill("000000")
    await page.getByTestId("phone-submit").click()
    await expect(page.getByTestId("phone-login-error")).toContainText(
      "手机号或验证码有误"
    )
    await expect(page).toHaveURL(/\/sign-in/)

    // 3. 绑过的号：等第 1 步那次发码的 60 秒冷却过去，再发一次、登进来
    await page.goto("/sign-in")
    await page.getByTestId("method-phone").click()
    await page.getByTestId("phone").fill(PHONE)
    await expect
      .poll(
        async () => {
          if ((await page.getByTestId("sms-sent").count()) > 0) return "sent"
          const send = page.getByTestId("sms-send")
          // 按钮禁用 = 已经发出去、在倒计时（提示语下一帧就出来）；不能对着禁用按钮 click，Playwright 会等它可用等到超时
          if (await send.isDisabled()) return "pending"
          await send.click()
          return "pending"
        },
        { timeout: 90_000, intervals: [3_000] }
      )
      .toBe("sent")
    await page.getByTestId("sms-code").fill(await codeFor(PHONE))
    await page.getByTestId("phone-submit").click()
    await expect(page).toHaveURL(/\/dashboard/)
  } finally {
    // 收尾在 finally：admin 的号解掉、配置删掉（中途红了也要）
    await api.del("/api/v1/sys/users/me/phone").catch(() => undefined)
    const list = (await api.get("/api/v1/sms/configs?page=1&size=50")) as {
      items: { id: string; name: string }[]
    }
    for (const item of list.items.filter((i) => i.name === name)) {
      await api.del(`/api/v1/sms/configs/${item.id}`)
    }
  }
})
