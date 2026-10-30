import { createHmac } from "node:crypto"
import { createServer, type Server } from "node:http"

import { expect, test } from "../fixtures/base"

/**
 * 群机器人（#166 二期）：在界面上新增一个飞书机器人 → 发测试消息 → 假飞书**用那把加签密钥验得过签名** →
 * 平台回「没有关键词」时卡片上看得到原因 → 发一条公告，投递记录里有发去这个群的那一行。
 *
 * 假飞书起在 `.env.e2e` 放行的那个前缀上（`NOTIFICATION_BOT_EXTRA_URL_PREFIXES`，端口写死 18765：
 * 前缀连端口一起比，随机端口放行不了）。生产只放行三家官方地址。
 *
 * 会静默坏的两处：
 * - 签名算反了（飞书是 `timestamp\n密钥` 当 HMAC 的密钥、签空串）：界面上只看得到「签名校验没过」，像是密钥填错了
 * - Webhook 地址本身就是凭据：卡片上只能有掩码，完整的 token 不能出现在页面上
 *
 * 公告那一步只断言「投递行写下了」：E2E 环境没有 Celery worker，真发出去由 pytest 管（`test_bots.py`）。
 */
const PORT = 18765
const TOKEN = `e2e-${Date.now().toString(36)}-0123456789`
const SECRET = "e2e-feishu-secret"

type Hit = { body: Record<string, unknown> }

function startFakeFeishu(): Promise<{ server: Server; hits: Hit[]; reply: { code: number; msg: string } }> {
  const hits: Hit[] = []
  const reply = { code: 0, msg: "success" }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      hits.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(reply))
    })
  })
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve({ server, hits, reply })))
}

/** 飞书官方文档的算法：key = `${timestamp}\n${secret}`，对空串做 HmacSHA256，再 Base64 */
function feishuSign(secret: string, timestamp: string): string {
  return createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64")
}

test.describe("群机器人", () => {
  test("新增飞书机器人 → 测试消息验签通过 → 失败原因上卡片 → 公告进投递", async ({ authedPage: page, api }) => {
    const { server, hits, reply } = await startFakeFeishu()
    const name = `E2E 群 ${Date.now().toString(36)}`
    let botId: string | null = null
    let noticeId: string | null = null
    try {
      await page.goto("/notify/bot")
      const tab = page.locator('[data-tab="/_auth/notify/bot"]')
      await tab.getByTestId("bot-add").click()

      await page.getByTestId("bot-name").fill(name)
      await page.getByTestId("bot-webhook").fill(`http://127.0.0.1:${PORT}/open-apis/bot/v2/hook/${TOKEN}`)
      await page.getByTestId("bot-secret").fill(SECRET)
      // 只列出对一个群说得通的类型：「抄送给你」不在里面
      await expect(page.getByTestId("bot-kind-workflow.cc")).toHaveCount(0)
      await page.getByTestId("bot-kind-announcement").click()
      await page.getByTestId("bot-submit").click()

      const card = tab.getByTestId(`bot-card-${name}`)
      await expect(card).toBeVisible()
      await expect(card).toContainText("已开签名校验")
      // 地址就是凭据：页面上只有掩码
      await expect(tab.getByTestId(`bot-hint-${name}`)).toContainText("6789")
      await expect(tab).not.toContainText(TOKEN)

      const bots = (await api.get("/api/v1/sys/notification-channels/bots")) as { id: string; name: string }[]
      botId = bots.find((b) => b.name === name)?.id ?? null

      await card.getByTestId(`bot-test-${name}`).click()
      await expect.poll(() => hits.length).toBe(1)
      const body = hits[0].body
      expect(body.msg_type).toBe("post")
      expect(body.sign).toBe(feishuSign(SECRET, String(body.timestamp)))
      expect(body.sign).not.toBe(feishuSign("wrong", String(body.timestamp)))
      await expect(card).not.toContainText("最近失败")

      // 平台拒了：原因落在卡片上，不是一闪而过
      reply.code = 19024
      reply.msg = "Key Words Not Found"
      await card.getByTestId(`bot-test-${name}`).click()
      await expect(tab.getByTestId(`bot-last-error-${name}`)).toContainText("Key Words Not Found")

      // 发一条公告：投递记录里有发去这个群的一行（没有 worker，停在「待发」）
      const notice = (await api.post("/api/v1/sys/notices", {
        title: `E2E 群机器人公告 ${name}`,
        type: 1,
        status: 1,
        content: "<p>E2E</p>",
      })) as { id: string }
      noticeId = notice.id
      await page.goto("/notify/delivery?channel=bot")
      const deliveries = page.locator('[data-tab="/_auth/notify/delivery"]')
      await expect(deliveries.getByRole("row", { name: new RegExp(name) })).toBeVisible()
    } finally {
      if (noticeId) await api.del("/api/v1/sys/notices", { pks: [noticeId] }).catch(() => undefined)
      if (botId) await api.del(`/api/v1/sys/notification-channels/bots/${botId}`).catch(() => undefined)
      server.close()
    }
  })
})
