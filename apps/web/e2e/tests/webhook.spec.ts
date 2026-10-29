import { createHmac } from "node:crypto"
import { createServer, type IncomingHttpHeaders, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { expect, test } from "../fixtures/base"

/**
 * Webhook 事件订阅（#167）：在界面上把一个端点从无到有走通。
 *
 * 测试自己在 127.0.0.1 上起一个接收端（E2E 的后端开着 `OPEN_WEBHOOK_ALLOW_PRIVATE_NETWORK`，生产是关的）：
 * 应用行菜单 → Webhook 抽屉 → 新增端点 → 密钥只显示一次 → 发测试 → 接收端真的收到、**用那把密钥验得过签名** →
 * 投递记录里有这一条、详情里是请求体和第 1 次尝试 → 刷新之后抽屉和页签还在（视图状态在 URL 里，硬纪律 2）。
 *
 * 会静默坏的是验签那一步：后端签的字节和发出去的字节不一致（多序列化一次），界面上照样显示「成功」——
 * 对方收到了、回了 200，只是对方的验签全部失败、把每条事件都丢掉。所以这里在接收端按规范自己算一遍。
 */
type Received = { headers: IncomingHttpHeaders; body: string }

function startReceiver(): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") })
      res.writeHead(200, { "content-type": "application/json" })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, received }))
  )
}

function verify(secret: string, r: Received): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const expected = createHmac("sha256", key)
    .update(`${r.headers["webhook-id"]}.${r.headers["webhook-timestamp"]}.${r.body}`)
    .digest("base64")
  return String(r.headers["webhook-signature"] ?? "")
    .split(" ")
    .some((part) => part === `v1,${expected}`)
}

test.describe("Webhook 事件订阅", () => {
  test("新增端点 → 发测试 → 接收端验签通过 → 投递记录可查", async ({ authedPage: page, api }) => {
    const { server, port, received } = await startReceiver()
    const code = `E2E_WH_${Date.now().toString(36).toUpperCase()}`
    const app = (await api.post("/api/v1/open-apps", {
      code,
      name: "E2E Webhook",
      scopes: ["user:read", "dept:read"],
    })) as { id: string }
    let hookId: string | null = null
    try {
      await page.goto("/open/app")
      const tab = page.locator('[data-tab="/_auth/open/app"]')
      await tab.getByTestId(`row-actions-${code}`).click()
      await page.getByTestId(`webhooks-${code}`).click()

      const sheet = page.getByTestId("webhook-sheet")
      await expect(sheet).toBeVisible()
      await sheet.getByTestId("webhook-add").click()

      const form = page.getByTestId("webhook-form")
      await form.getByTestId("webhook-name").fill("E2E 接收端")
      await form.getByTestId("webhook-url").fill(`http://127.0.0.1:${port}/hook`)
      // 应用没授权审批：那一组是灰的
      await expect(form.getByTestId("webhook-event-workflow.instance.*")).toBeDisabled()
      await form.getByTestId("webhook-event-dept.*").click()
      await form.getByTestId("webhook-submit").click()

      // 密钥只显示这一次
      const secret = (await page.getByTestId("webhook-secret").textContent())?.trim() ?? ""
      expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/)
      await page.getByTestId("webhook-secret-saved").click()

      const card = sheet.getByTestId("webhook-card-E2E 接收端")
      await expect(card).toContainText("dept.*")
      await expect(card).not.toContainText(secret)

      await card.getByTestId("webhook-ping-E2E 接收端").click()
      const result = card.getByTestId("webhook-ping-result-E2E 接收端")
      await expect(result).toContainText("成功")
      await expect(result).toContainText("200")

      // 接收端真的收到了，而且用界面上那把密钥验得过
      expect(received).toHaveLength(1)
      expect(JSON.parse(received[0].body)).toMatchObject({ type: "ping" })
      expect(verify(secret, received[0])).toBe(true)
      expect(verify(`whsec_${Buffer.alloc(24).toString("base64")}`, received[0])).toBe(false)

      const hooks = (await api.get(`/api/v1/open-webhooks?app_id=${app.id}`)) as { id: string }[]
      hookId = hooks[0]?.id ?? null

      // 投递记录：这条测试事件在、点开是请求体和第 1 次尝试
      await sheet.getByTestId("webhook-tab-deliveries").click()
      await sheet.getByTestId("webhook-delivery-ping").click()
      const detail = page.getByTestId("webhook-delivery-detail")
      await expect(detail.getByTestId("webhook-payload")).toContainText('"type": "ping"')
      await expect(detail.getByTestId("webhook-attempt-1")).toContainText("200")
      await page.keyboard.press("Escape")

      // 刷新之后：抽屉还开着、停在投递记录页签（全在 URL 里）
      await page.reload()
      await expect(page.getByTestId("webhook-sheet")).toBeVisible()
      await expect(page.getByTestId("webhook-delivery-ping")).toBeVisible()
    } finally {
      if (hookId) await api.del(`/api/v1/open-webhooks/${hookId}`).catch(() => undefined)
      await api.del(`/api/v1/open-apps/${app.id}`).catch(() => undefined)
      server.close()
    }
  })
})
