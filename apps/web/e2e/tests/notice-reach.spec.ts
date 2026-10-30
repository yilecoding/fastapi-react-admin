import { readFile } from "node:fs/promises"

import { request } from "@playwright/test"

import type { APIRequestContext, Page } from "@playwright/test"

import { API_BASE, createApiClient, expect, loginPageAs, loginToken, test } from "../fixtures/base"
import type { ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"
import { buildPdf } from "../utils/pdf"

/**
 * 公告触达面（#186）：**普通用户**能读到公告的正文和附件。
 *
 * 修之前全站唯一能读公告的地方是管理页（路由守卫 `sys:notice:add`）：铃铛 / 消息中心里那一行
 * 链到 `/plugins/notice`，普通用户点进去是 `/403`，而且这一下已经把它标成已读了；工作台上没有公告；
 * 附件在读者这一侧根本没有界面。这几条全是**非管理员**视角 —— admin 什么都看得到，拿它测是假绿。
 *
 * 账号：`test`（普通员工，只用在铃铛那一条）+ `zhoumin`（只读访客）。
 * zhoumin 也被 `workflow-ai-fill.spec.ts` 用着，#138 之后网页端会话默认不限数，不会互相踢
 * （e2e 分册「两个 spec 文件不要登同一个演示账号」那条的前提已经不在了）。
 *
 * 公告是**全员广播**，并行的别的 spec（`notify-bot.spec.ts` 也发公告）会往同一个收件箱里加行 ——
 * 所以一律按这条测试自己造的标题 / id 定位，不断言「第一行是谁」「一共几条」。
 */

type Uploaded = { id: string; original_name: string; size: number }
type Notice = { id: string; title: string }

test.describe("公告触达面 · 读者视角", () => {
  let admin: ApiClient
  let disposeAdmin: () => Promise<void>
  let ctx: APIRequestContext
  let adminToken: string
  const notices: string[] = []
  const files: string[] = []

  test.beforeAll(async () => {
    ;({ api: admin, dispose: disposeAdmin } = await createApiClient())
    ctx = await request.newContext({ baseURL: API_BASE })
    adminToken = (await loginToken(ctx)).token
  })

  test.afterAll(async () => {
    if (notices.length) await admin.del("/api/v1/sys/notices", { pks: notices }).catch(() => {})
    if (files.length) {
      await ctx
        .delete(`${API_BASE}/api/v1/sys/files`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: { pks: files },
        })
        .catch(() => {})
    }
    await ctx.dispose()
    await disposeAdmin()
  })

  /** 管理员发一条「显示」的公告（= 立刻全员广播） */
  async function publish(opts: { level?: number; attachmentIds?: string[] } = {}): Promise<Notice & { body: string }> {
    const code = uniqueCode("NR")
    const title = `E2E公告-${code}`
    const body = `读者能看到的正文-${code}`
    const notice = (await admin.post("/api/v1/sys/notices", {
      title,
      type: 1,
      status: 1,
      content: `<p>${body}</p>`,
      pinned: false,
      level: opts.level ?? 0,
      expire_time: null,
      ...(opts.attachmentIds ? { attachment_ids: opts.attachmentIds } : {}),
    })) as Notice
    notices.push(notice.id)
    return { ...notice, body }
  }

  /** 私有上传（不带 `public`）—— 公告附件只收私有文件，公开的后端整条 400 */
  async function uploadPdf(name: string, buffer: Buffer): Promise<Uploaded> {
    const res = await ctx.post(`${API_BASE}/api/v1/sys/files/upload`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      multipart: { file: { name, mimeType: "application/pdf", buffer } },
    })
    expect(res.ok(), `上传失败：${await res.text()}`).toBeTruthy()
    const file = ((await res.json()) as { data: Uploaded }).data
    files.push(file.id)
    return file
  }

  /** 页面里开在 URL 上的抽屉挂在本 tab 的根节点下（硬纪律 5：按 routeId 锁，不按 data-visible） */
  const readerIn = (page: Page, routeId: string) => page.locator(`[data-tab="${routeId}"] [data-testid="notice-reader"]`)

  test("🔴 普通员工点铃铛里的公告：就地打开正文，不进 /403", async ({ page }) => {
    const notice = await publish({ level: 2 })
    await loginPageAs(page, "test", "123456")
    await page.goto("/dashboard")

    await page.getByTestId("notification-bell").click()
    await page.getByTestId("notification-tab-announcement").click()
    const row = page.getByTestId("notification-item").filter({ hasText: notice.title })
    // 认的是 `source`，不是 `link`：这一行是按钮，带着公告 id
    await expect(row).toHaveAttribute("data-notice-id", notice.id)
    await row.click()

    // 铃铛是外壳家具，它的抽屉挂在 <body> 下（不在任何 tab 里）
    const reader = page.getByTestId("notice-reader")
    await expect(reader.getByTestId("notice-reader-title")).toHaveText(notice.title)
    await expect(reader.getByTestId("notice-content")).toContainText(notice.body)
    await expect(reader.getByTestId("notice-level")).toHaveAttribute("data-level", "2")
    await expect(page).not.toHaveURL(/\/403/)
    // 修之前那一下的落点：`/403?from=/plugins/notice&need=sys:notice:add`
    await expect(page).toHaveURL(/\/dashboard/)
  })

  test("🔴 消息中心：点公告那一行在本页打开，`?notice=` 进 URL；深链直接打开那一条", async ({ page }) => {
    const notice = await publish()
    await loginPageAs(page, "zhoumin", "123456")

    await page.goto("/notification?category=1")
    const table = page.locator('[data-tab="/_auth/notification"] [data-testid="notification-table"]')
    const row = table.locator(`[data-notice-id="${notice.id}"]`)
    await row.click()

    const reader = readerIn(page, "/_auth/notification")
    await expect(reader.getByTestId("notice-content")).toContainText(notice.body)
    // 硬纪律 6：雪花 ID 在地址栏里原样是字符串，没被 JSON.parse 截断
    await expect(page).toHaveURL(new RegExp(`[?&]notice=${notice.id}(&|$)`))
    await expect(page).toHaveURL(/category=1/)

    // 关掉 = 把 `notice` 从 URL 里拿掉，筛选留着
    await page.keyboard.press("Escape")
    await expect(reader).toBeHidden()
    await expect(page).not.toHaveURL(/notice=/)
    await expect(page).toHaveURL(/category=1/)

    // 收件箱 / 群机器人卡片里的 `link` 就是这个形状：直接进来就打开那一条
    await page.goto(`/notification?notice=${notice.id}`)
    await expect(readerIn(page, "/_auth/notification").getByTestId("notice-reader-title")).toHaveText(notice.title)
  })

  test("🔴 工作台公告卡取数失败：错误块 + 重试，不是「暂无公告」", async ({ page }) => {
    await loginPageAs(page, "zhoumin", "123456")
    let fail = true
    // 只拦卡片那一个列表端点（正则带 `?`，详情 `/feed/{id}` 不受影响）
    await page.route(/\/api\/v1\/sys\/notices\/feed\?/, (route) =>
      fail
        ? route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' })
        : route.fallback()
    )
    await page.goto("/dashboard")

    const card = page.locator('[data-tab="/_auth/dashboard"] [data-testid="dash-notices"]')
    await expect(card.getByTestId("dash-notices-error")).toBeVisible()
    await expect(card.getByTestId("dash-notices-empty")).toHaveCount(0)

    fail = false
    await card.getByTestId("dash-notices-error").getByRole("button").click()
    await expect(card.getByTestId("dash-notices-error")).toBeHidden()
    await expect(card.locator('[data-testid^="dash-notice-"], [data-testid="dash-notices-empty"]').first()).toBeVisible()
  })

  test.describe("附件：看得到 → 隐藏之后看不到", () => {
    // 三条接着用同一条带附件的公告：先读者看得到附件 → 工作台上带 📎 → 隐藏之后附件跟着读不到
    test.describe.configure({ mode: "serial" })

    let attached: { notice: Notice & { body: string }; pdf: Uploaded; bytes: Buffer }

    test("🔴 附件：读者看到原文件名 + 大小，PDF 能预览，下载下来是原文件名、字节一致", async ({ page }) => {
      const code = uniqueCode("NA")
      const bytes = buildPdf(`notice ${code}`)
      // 中文原名：落盘名带随机后缀，响应头的 ASCII 兜底会把中文去掉 —— 两个都不能漏给读者
      const pdf = await uploadPdf(`公告附件-${code}.pdf`, bytes)
      const notice = await publish({ attachmentIds: [pdf.id] })
      attached = { notice, pdf, bytes }

      await loginPageAs(page, "zhoumin", "123456")
      await page.goto(`/notification?notice=${notice.id}`)
      const reader = readerIn(page, "/_auth/notification")
      await expect(reader.getByTestId("notice-content")).toContainText(notice.body)

      const box = reader.getByTestId("file-attachments")
      await expect(box).toHaveAttribute("data-readonly", "true")
      await expect(box.getByTestId("attach-heading")).toHaveText(/（1）|\(1\)/)
      const item = box.getByTestId(`attach-item-${pdf.id}`)
      await expect(item.getByTestId("attach-name")).toHaveText(pdf.original_name)
      expect(pdf.size, "样本 PDF 应小于 1KB（下面按字节数断言显示）").toBeLessThan(1024)
      await expect(item.getByTestId("attach-size")).toHaveText(`${pdf.size} B`)
      // 读者视图没有「添加 / 移除」
      await expect(box.getByTestId("attach-upload")).toHaveCount(0)
      await expect(item.getByTestId(`attach-detach-${pdf.id}`)).toHaveCount(0)

      // 预览：弹窗里画出 PDF（普通员工在浏览器里打开预览，#186 验收那条「没跑过」的）
      await item.getByTestId(`attach-preview-${pdf.id}`).click()
      const dialog = page.getByTestId("file-preview-dialog")
      await expect(dialog.locator("canvas").first()).toBeVisible({ timeout: 20_000 })
      await page.keyboard.press("Escape")
      await expect(dialog).toBeHidden()

      // 下载：带鉴权取字节 → Blob → 以原文件名存
      const download = page.waitForEvent("download")
      await item.getByTestId(`attach-download-${pdf.id}`).click()
      const file = await download
      expect(file.suggestedFilename()).toBe(pdf.original_name)
      const saved = await readFile((await file.path())!)
      expect(saved.equals(bytes), "下载下来的字节和上传的不一致").toBeTruthy()
    })

    test("🔴 工作台：非管理员也有公告卡（旁边那条「没有权限」照旧），点一行就地打开", async ({ page }) => {
      const { notice, pdf } = attached
      await loginPageAs(page, "zhoumin", "123456")
      await page.goto("/dashboard")

      const card = page.locator('[data-tab="/_auth/dashboard"] [data-testid="dash-notices"]')
      const row = card.getByTestId(`dash-notice-${notice.id}`)
      await expect(row).toContainText(notice.title)
      // 📎 个数：读者打开之前就知道这条带文件
      await expect(row.getByTestId("attachment-count")).toContainText("1")
      // 别的卡是管理员看板：普通用户这里是那条错误条 —— 公告卡要在它旁边照常显示
      await expect(page.locator('[data-tab="/_auth/dashboard"] [data-testid="dash-error"]')).toBeVisible()

      await row.click()
      const reader = readerIn(page, "/_auth/dashboard")
      await expect(reader.getByTestId("notice-reader-title")).toHaveText(notice.title)
      await expect(reader.getByTestId(`attach-item-${pdf.id}`)).toBeVisible()
      await expect(page).toHaveURL(new RegExp(`[?&]notice=${notice.id}(&|$)`))
    })

    test("🔴 管理员打开读者那份详情：也没有「添加 / 移除」附件", async ({ authedPage: page }) => {
      // 上面用的 zhoumin 本来就没有 `sys:file:upload`，那两个按钮靠权限也藏得住 ——
      // 拿它断言「读者视图只读」是假绿。admin 有这个码，只有 `readOnly` 挡得住
      const { notice, pdf } = attached
      await page.goto(`/notification?notice=${notice.id}`)
      const box = readerIn(page, "/_auth/notification").getByTestId("file-attachments")
      await expect(box.getByTestId(`attach-item-${pdf.id}`)).toBeVisible()
      await expect(box.getByTestId("attach-upload")).toHaveCount(0)
      await expect(box.getByTestId(`attach-detach-${pdf.id}`)).toHaveCount(0)
    })

    test("🔴 公告隐藏之后：读者打开是「已撤回」，附件列表为空、下载 404", async ({ page }) => {
      const { notice, pdf } = attached
      // 只改状态；不带 attachment_ids = 附件不动
      await admin.put(`/api/v1/sys/notices/${notice.id}`, {
        title: notice.title,
        type: 1,
        status: 0,
        content: `<p>${notice.body}</p>`,
        pinned: false,
        level: 0,
        expire_time: null,
      })

      await loginPageAs(page, "zhoumin", "123456")
      await page.goto(`/notification?notice=${notice.id}`)
      const reader = readerIn(page, "/_auth/notification")
      await expect(reader.getByTestId("notice-reader-gone")).toBeVisible()
      await expect(reader.getByTestId("notice-content")).toHaveCount(0)
      await expect(reader.getByTestId("file-attachments")).toHaveCount(0)

      // 接口那一层：「看得见这条公告，才打得开它的附件」
      const reader2 = await request.newContext({ baseURL: API_BASE })
      try {
        const { token } = await loginToken(reader2, "zhoumin", "123456")
        const headers = { Authorization: `Bearer ${token}` }
        const list = await reader2.get(`${API_BASE}/api/v1/sys/files/targets/NOTICE/${notice.id}`, { headers })
        expect(((await list.json()) as { data: unknown[] }).data).toEqual([])
        const dl = await reader2.get(`${API_BASE}/api/v1/sys/files/${pdf.id}/download`, { headers })
        expect(dl.status()).toBe(404)
      } finally {
        await reader2.dispose()
      }
    })
  })
})
