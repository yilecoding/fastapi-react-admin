import { createHmac } from "node:crypto"

import { expect, loginPageAs, test } from "../fixtures/base"

/**
 * 二次验证（#181）：个人中心开启 → 恢复码只显示一次 → 退出 → 密码登录停在第二步 → 动态码进系统。
 *
 * 会静默坏的两处：
 * - 开启之后登录照样一步进来（某条登录路径漏了第二步）—— 这里断言「密码对了之后看到的是动态码框，不是工作台」
 * - 绑定确认用的是**扫码那一刻**的密钥：测试从界面上读密钥、自己按 RFC 6238 算码，
 *   界面上的二维码 / 密钥和服务端存下的对不上，这一步就过不去
 *
 * 强制策略（参数配置里改成「所有人必须开」）不在 E2E 里测：那是全局开关，会波及并行跑的别的用例，
 * pytest 的 `test_mfa.py::TestEnforced` 管它。
 */

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = ""
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const v = alphabet.indexOf(ch)
    if (v < 0) throw new Error(`不是 base32：${ch}`)
    bits += v.toString(2).padStart(5, "0")
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}

/** RFC 6238：SHA1 / 30 秒 / 6 位。`stepsAhead` 往后数几个时间片（同一片的码服务端只认一次） */
function totp(secret: string, stepsAhead = 0): string {
  const counter = Math.floor(Date.now() / 1000 / 30) + stepsAhead
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac("sha1", base32Decode(secret)).update(buf).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, "0")
}

test.describe("二次验证", () => {
  test("个人中心开启 → 退出 → 密码登录要动态码", async ({ page, api }) => {
    const username = `e2e_mfa_${Date.now().toString(36)}`
    const password = "E2eMfa@123456"
    const depts = (await api.get("/api/v1/sys/depts")) as { id: string }[]
    const roles = (await api.get("/api/v1/sys/roles/all")) as { id: string }[]
    const user = (await api.post("/api/v1/sys/users", {
      username,
      password,
      nickname: "MFA",
      dept_id: depts[0].id,
      roles: [roles[0].id],
    })) as { id: string }
    try {
      await loginPageAs(page, username, password)
      await page.goto("/profile?section=security")
      const block = page.locator('[data-tab="/_auth/profile"] [data-testid="profile-mfa"]')
      await block.getByTestId("mfa-enable").click()

      await expect(block.getByTestId("mfa-qr")).toBeVisible()
      const secret = ((await block.getByTestId("mfa-secret").textContent()) ?? "").trim()
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      await block.getByTestId("mfa-otp").fill(totp(secret))
      await block.getByTestId("mfa-enable-confirm").click()

      // 恢复码只显示这一次
      await expect(block.getByTestId("mfa-recovery-code")).toHaveCount(10)
      await block.getByTestId("mfa-codes-done").click()
      await expect(block.getByTestId("mfa-enabled")).toBeVisible()

      // 退出，用密码重新登录：停在第二步
      await page.context().clearCookies()
      await page.goto("/sign-in")
      await page.getByTestId("username").fill(username)
      await page.getByTestId("password").fill(password)
      await page.getByTestId("submit").click()
      await expect(page.getByTestId("mfa-step")).toBeVisible()
      await expect(page.getByTestId("page-title")).toHaveCount(0)

      // 错的码：说清楚，留在这一步
      await page.getByTestId("mfa-otp").fill("000000")
      await page.getByTestId("mfa-submit").click()
      await expect(page.getByTestId("mfa-error")).toBeVisible()

      // 开启时用掉了当前这一片，用下一片（服务端前后各容忍一片）
      await page.getByTestId("mfa-otp").fill(totp(secret, 1))
      await page.getByTestId("mfa-submit").click()
      await expect(page.getByTestId("page-title")).toBeVisible()
    } finally {
      await api.del(`/api/v1/sys/users/${user.id}/mfa`).catch(() => undefined)
      await api.del(`/api/v1/sys/users/${user.id}`).catch(() => undefined)
    }
  })
})
