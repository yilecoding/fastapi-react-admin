import { request } from "@playwright/test"

import type { Browser, Page } from "@playwright/test"

import { API_BASE, createApiClient, expect, loginPageAs, loginToken, test } from "../fixtures/base"
import type { ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 公告二期（#190）：定向发布 · 登录后弹窗（必须确认）· 顶部横幅 · 登录页公告 · 阅读统计 · 管理表单的发布范围。
 *
 * 🔴 **全用非管理员看**（admin 什么都看得到，拿它测定向 / 弹窗全是假绿），而且**弹窗 / 横幅一律只发给这个文件自己建的账号**：
 * 一条发给全员的弹窗会在**并行的所有 spec** 上盖一层 modal，整套用例一起红、报错各不相同。
 *
 * 账号：
 * - `liuyang`（后端组，技术中心下面）/ `sunqiang`（市场运营中心）：定向那一条。发的是**普通公告**（不弹窗、不横幅），
 *   只往他们的收件箱里加一行 —— 别的 spec 也用这两个人（审批），一行未读不影响它们
 * - 现建的 7 个账号（`beforeAll`，普通员工 · 市场运营中心）：弹窗 / 横幅 / 阅读统计 / 读者确认 / 让行导览 / 消息中心 / 弹窗撤回各用一个，互不干扰。
 *   🔴 账号要**先于公告**建好：新账号规则是「建号之前发的广播算已读」（必须确认的除外）
 * - 登录页那条只能发给全员（登录页可见 + 有范围 = 422），所以断言完立刻删掉，缩短它在别人收件箱里的时间
 */

type Notice = { id: string; title: string }
type Audience = { kind: "dept" | "role" | "user"; target_id: string }

const PASSWORD = "Np2!123456"

test.describe("公告二期 · 定向 / 弹窗 / 横幅 / 登录页 / 阅读统计", () => {
  let admin: ApiClient
  let disposeAdmin: () => Promise<void>
  const notices: string[] = []
  /** 走界面建的公告拿不到 id（表单不回显），按标题收尾 —— 用例中途红了也不会漏在库里（变异测试时实测漏过一条） */
  const uiTitles: string[] = []
  const users: Record<"popup" | "banner" | "reads" | "ack" | "tour" | "inbox" | "gone", { id: string; username: string }> =
    {} as never
  let techDeptId = ""
  let sunqiangId = ""

  test.beforeAll(async () => {
    ;({ api: admin, dispose: disposeAdmin } = await createApiClient())
    type DeptNode = { id: string; name: string; children?: DeptNode[] }
    const tree = (await admin.get("/api/v1/sys/depts")) as DeptNode[]
    const flat: DeptNode[] = []
    const walk = (ns: DeptNode[]) => ns.forEach((n) => (flat.push(n), walk(n.children ?? [])))
    walk(tree)
    techDeptId = flat.find((d) => d.name === "技术中心")!.id
    const marketId = flat.find((d) => d.name === "市场运营中心")!.id
    const roles = (await admin.get("/api/v1/sys/roles/all")) as { id: string; name: string }[]
    const staffRole = roles.find((r) => r.name === "普通员工")!.id
    const sq = (await admin.get("/api/v1/sys/users?username=sunqiang")) as { items: { id: string; username: string }[] }
    sunqiangId = sq.items.find((u) => u.username === "sunqiang")!.id

    for (const key of ["popup", "banner", "reads", "ack", "tour", "inbox", "gone"] as const) {
      const username = `np2_${key}_${uniqueCode("U").slice(2).toLowerCase()}`.slice(0, 30)
      const user = (await admin.post("/api/v1/sys/users", {
        username,
        password: PASSWORD,
        nickname: username,
        email: `${username}@e2e.example.com`,
        dept_id: marketId,
        roles: [staffRole],
      })) as { id: string }
      users[key] = { id: user.id, username }
    }
  })

  test.afterAll(async () => {
    for (const title of uiTitles) {
      const found = (await admin
        .get(`/api/v1/sys/notices?page=1&size=5&title=${encodeURIComponent(title)}`)
        .catch(() => ({ items: [] }))) as { items: { id: string }[] }
      notices.push(...found.items.map((n) => n.id))
    }
    if (notices.length) await admin.del("/api/v1/sys/notices", { pks: notices }).catch(() => {})
    for (const u of Object.values(users)) await admin.del(`/api/v1/sys/users/${u.id}`).catch(() => {})
    await disposeAdmin()
  })

  /** 管理员发一条「显示」的公告（= 立刻写收件箱）。默认什么开关都不开、全员 —— 调用处按需覆盖 */
  async function publish(
    opts: {
      audience?: Audience[]
      popup?: boolean
      requireAck?: boolean
      pinned?: boolean
      level?: number
      isPublic?: boolean
      body?: string
    } = {}
  ): Promise<Notice & { body: string }> {
    const code = uniqueCode("NP")
    const title = `E2E二期-${code}`
    const body = opts.body ?? `二期正文-${code}`
    const notice = (await admin.post("/api/v1/sys/notices", {
      title,
      type: 1,
      status: 1,
      content: `<p>${body}</p>`,
      pinned: opts.pinned ?? false,
      level: opts.level ?? 0,
      expire_time: null,
      popup: opts.popup ?? false,
      require_ack: opts.requireAck ?? false,
      public: opts.isPublic ?? false,
      audience: opts.audience ?? [],
    })) as Notice
    notices.push(notice.id)
    return { ...notice, body }
  }

  const toUser = (key: keyof typeof users): Audience[] => [{ kind: "user", target_id: users[key].id }]

  /** 一个独立的浏览器上下文（同一条测试里要换第二个人看） */
  async function pageAs(browser: Browser, username: string, password = "123456"): Promise<Page> {
    const ctx = await browser.newContext()
    const p = await ctx.newPage()
    await loginPageAs(p, username, password)
    return p
  }

  /** 这个人自己看这条公告的读者详情（读没读、收件箱那一行的 id） */
  async function feedDetailAs(username: string, noticeId: string) {
    const ctx = await request.newContext({ baseURL: API_BASE })
    try {
      const { token } = await loginToken(ctx, username, PASSWORD)
      const res = await ctx.get(`${API_BASE}/api/v1/sys/notices/feed/${noticeId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return ((await res.json()) as { data: { read: boolean; notification_id: string } }).data
    } finally {
      await ctx.dispose()
    }
  }

  test("🔴 定向发布：发给技术中心 → 后端组的 liuyang 看得到；市场的 sunqiang 铃铛里没有、深链是「已撤回或已过期」", async ({
    page,
    browser,
  }) => {
    const targeted = await publish({ audience: [{ kind: "dept", target_id: techDeptId }] })
    // sunqiang 这边的正向对照：先看到这条，才能说明「没有那一条」不是列表还没加载出来（e2e 分册：先断言应该看见的）
    const control = await publish({ audience: [{ kind: "user", target_id: sunqiangId }] })

    // liuyang 在后端组（技术中心的下级）：受众是「技术中心」也要包含他
    await loginPageAs(page, "liuyang", "123456")
    await page.goto("/dashboard")
    await page.getByTestId("notification-bell").click()
    await page.getByTestId("notification-tab-announcement").click()
    const row = page.getByTestId("notification-item").filter({ hasText: targeted.title })
    await expect(row).toHaveAttribute("data-notice-id", targeted.id)
    await row.click()
    await expect(page.getByTestId("notice-reader").getByTestId("notice-content")).toContainText(targeted.body)

    const sq = await pageAs(browser, "sunqiang")
    try {
      await sq.goto("/dashboard")
      await sq.getByTestId("notification-bell").click()
      await sq.getByTestId("notification-tab-announcement").click()
      const items = sq.getByTestId("notification-item")
      await expect(items.filter({ hasText: control.title })).toBeVisible()
      await expect(items.filter({ hasText: targeted.title })).toHaveCount(0)

      // 拿到链接直接打开：和撤回 / 过期一样是 404（后端不区分「不存在」和「不在范围里」）
      await sq.goto(`/notification?notice=${targeted.id}`)
      const reader = sq.locator('[data-tab="/_auth/notification"] [data-testid="notice-reader"]')
      await expect(reader.getByTestId("notice-reader-gone")).toBeVisible()
      await expect(reader.getByTestId("notice-content")).toHaveCount(0)
    } finally {
      await sq.context().close()
    }
  })

  test("🔴 必须确认的弹窗：登录后弹出、只有「我已阅读」一个出口；确认后刷新不再弹；在线时新发的当场弹", async ({
    page,
  }) => {
    const must = await publish({ popup: true, requireAck: true, level: 2, audience: toUser("popup") })
    await loginPageAs(page, users.popup.username, PASSWORD)
    await page.goto("/dashboard")

    const popup = page.getByTestId("notice-popup")
    await expect(popup.getByTestId("notice-popup-title")).toHaveText(must.title)
    await expect(popup.getByTestId("notice-content")).toContainText(must.body)
    await expect(popup).toHaveAttribute("data-require-ack", "true")
    // 没有右上角的 ×，没有「知道了」
    await expect(popup.locator('[data-slot="dialog-close"]')).toHaveCount(0)
    await expect(popup.getByTestId("notice-popup-ok")).toHaveCount(0)

    // Esc / 点遮罩都关不掉。断言 `data-open` 而不是「看得见」：关掉之后还有一段退场动画，
    // 那段时间里它照样「看得见」—— 用 toBeVisible 会在变异版本上假绿（实测过）
    await page.keyboard.press("Escape")
    await expect(popup).toHaveAttribute("data-open", "")
    await page.mouse.click(8, 8)
    await expect(popup).toHaveAttribute("data-open", "")
    await expect(popup.getByTestId("notice-popup-title")).toHaveText(must.title)

    await popup.getByTestId("notice-popup-ack").click()
    await expect(popup).toBeHidden()
    expect((await feedDetailAs(users.popup.username, must.id)).read).toBe(true)

    // 刷新：等弹窗那条请求真的回来了再断言「没有」—— 不等的话骨架阶段本来就没有弹窗，是假绿
    const popupsLoaded = page.waitForResponse((r) => r.url().includes("/sys/notices/feed/popups") && r.ok())
    await page.reload()
    await popupsLoaded
    await expect(page.getByTestId("notification-bell")).toBeVisible()
    await expect(page.getByTestId("notice-popup")).toHaveCount(0)

    // 在线时新发一条：socket `notification:new` → 铃铛 `invalidateInbox` → 弹窗那份跟着重取（e2e 分册：先等 presence）
    await expect(page.locator("html[data-presence='on']")).toHaveCount(1)
    const live = await publish({ popup: true, audience: toUser("popup") })
    await expect(popup.getByTestId("notice-popup-title")).toHaveText(live.title)
    // 不必确认的：「知道了」也算看过
    await expect(popup).toHaveAttribute("data-require-ack", "false")
    await popup.getByTestId("notice-popup-ok").click()
    await expect(popup).toBeHidden()
    await expect.poll(async () => (await feedDetailAs(users.popup.username, live.id)).read).toBe(true)
  })

  test("🔴 必须确认的弹窗在弹着的时候撤回 / 过期了：「我已阅读」回 404 → 放走这一条、接着弹下一条，外壳不被锁死", async ({
    page,
  }) => {
    // 级别高的先弹：撤回的那条在前、还在的那条在后
    const gone = await publish({ popup: true, requireAck: true, level: 2, audience: toUser("gone") })
    const next = await publish({ popup: true, requireAck: true, audience: toUser("gone") })
    // 真撤回会推 socket、弹窗那份当场重取，那条就到不了「点了才 404」—— 这里只让标已读那一下回 404
    // （后端对撤回 / 过期 / 看不见的行就是这么回的，`PUT /sys/notifications/{id}/read`）
    const goneRow = (await feedDetailAs(users.gone.username, gone.id)).notification_id
    await page.route(new RegExp(`/api/v1/sys/notifications/${goneRow}/read`), (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ code: 404, msg: "通知不存在", data: null }),
      })
    )
    await loginPageAs(page, users.gone.username, PASSWORD)
    await page.goto("/dashboard")

    const popup = page.getByTestId("notice-popup")
    await expect(popup.getByTestId("notice-popup-title")).toHaveText(gone.title)
    // 404 说明手上那份是旧的：弹窗 / 铃铛那几份要跟着重取（`useMarkNoticeRead` 的 onError）
    const refetched = page.waitForResponse((r) => r.url().includes("/sys/notices/feed/popups"))
    await popup.getByTestId("notice-popup-ack").click()
    // 修之前：停在原地、按钮旁边一行「通知不存在」，再点还是 404，没有别的出口
    await expect(popup.getByTestId("notice-popup-title")).toHaveText(next.title)
    await expect(popup.getByTestId("notice-popup-error")).toHaveCount(0)
    await refetched

    await popup.getByTestId("notice-popup-ack").click()
    await expect(popup).toBeHidden()
    expect((await feedDetailAs(users.gone.username, next.id)).read).toBe(true)
  })

  test("🔴 首次登录：弹窗先、外壳导览后 —— 两个全屏浮层不叠在一起", async ({ page }) => {
    const must = await publish({ popup: true, requireAck: true, audience: toUser("tour") })
    // 没看过导览的新人（fixture 默认会把导览标成看过，这里关掉）
    await loginPageAs(page, users.tour.username, PASSWORD, { tourSeen: false })
    await page.goto("/dashboard")

    const popup = page.getByTestId("notice-popup")
    await expect(popup.getByTestId("notice-popup-title")).toHaveText(must.title)
    // 导览自动启动要等 800ms 稳定期；多给一倍，弹窗开着时它不能出来（shell/tour/gate.ts 按住了它）
    await page.waitForTimeout(1600)
    await expect(page.locator(".driver-popover")).toHaveCount(0)

    await popup.getByTestId("notice-popup-ack").click()
    await expect(popup).toBeHidden()
    // 放开之后导览照常弹出，而且点得动（没有被 modal 压住）
    await expect(page.locator(".driver-popover")).toBeVisible()
    await page.getByRole("button", { name: "下一步" }).click()
    await expect(page.locator(".driver-popover-progress-text")).toHaveText(/^2 \/ /)
  })

  test("🔴 横幅：置顶 + 紧急的出现在顶栏下；点 × = 已读，刷新也不再出现；点标题打开正文", async ({ page }) => {
    const urgent = await publish({ pinned: true, level: 2, audience: toUser("banner") })
    const second = await publish({ pinned: true, level: 2, audience: toUser("banner") })
    // 不是置顶 + 紧急的不上横幅（后端条件，这里顺手确认界面没自己加戏）
    const normal = await publish({ level: 2, audience: toUser("banner") })

    await loginPageAs(page, users.banner.username, PASSWORD)
    await page.goto("/dashboard")
    const banner = page.getByTestId("notice-banner")
    const item = (id: string) => banner.locator(`[data-testid="notice-banner-item"][data-notice-id="${id}"]`)
    await expect(item(urgent.id)).toContainText(urgent.title)
    await expect(item(second.id)).toBeVisible()
    await expect(item(normal.id)).toHaveCount(0)

    await item(urgent.id).getByTestId("notice-banner-close").click()
    await expect(item(urgent.id)).toHaveCount(0)
    await expect.poll(async () => (await feedDetailAs(users.banner.username, urgent.id)).read).toBe(true)

    const bannerLoaded = page.waitForResponse((r) => r.url().includes("/sys/notices/feed/banner") && r.ok())
    await page.reload()
    await bannerLoaded
    await expect(item(second.id)).toBeVisible()
    await expect(item(urgent.id)).toHaveCount(0)

    // 点标题：就地打开读者抽屉（不在任何 tab 里，挂 body），读了之后横幅里这一条也没了
    await item(second.id).getByTestId("notice-banner-open").click()
    const reader = page.getByTestId("notice-reader")
    await expect(reader.getByTestId("notice-content")).toContainText(second.body)
    await expect(item(second.id)).toHaveCount(0)
  })

  test("🔴 登录页：匿名访客看得到登录页可见的公告（长摘要能展开）；取数失败只是一行「重试」，不挡登录", async ({
    page,
  }) => {
    const long = "这是一段很长的登录页公告摘要，".repeat(8)
    const pub = await publish({ isPublic: true, level: 1, body: long })
    try {
      let fail = false
      await page.route(/\/api\/v1\/sys\/notices\/public/, (route) =>
        fail ? route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' }) : route.fallback()
      )
      await page.goto("/sign-in")
      const item = page.locator(`[data-testid="public-notice"][data-notice-id="${pub.id}"]`)
      await expect(item.getByTestId("public-notice-title")).toHaveText(pub.title)
      await expect(item.getByTestId("notice-level")).toHaveAttribute("data-level", "1")
      const summary = item.getByTestId("public-notice-summary")
      await expect(summary).toContainText("很长的登录页公告摘要")
      await expect(summary).toHaveClass(/line-clamp-2/)
      await item.getByTestId("public-notice-toggle").click()
      await expect(summary).not.toHaveClass(/line-clamp-2/)
      // 只给纯文本：正文的标签不出去
      await expect(summary).not.toContainText("<p>")

      fail = true
      await page.reload()
      await expect(page.getByTestId("public-notices-error")).toBeVisible()
      await expect(page.getByTestId("public-notices")).toHaveCount(0)
      // 登录表单照常可用
      await expect(page.getByTestId("submit")).toBeEnabled()

      fail = false
      await page.getByTestId("public-notices-retry").click()
      await expect(item.getByTestId("public-notice-title")).toHaveText(pub.title)
      await expect(page.getByTestId("public-notices-error")).toHaveCount(0)
    } finally {
      // 登录页可见的只能发给全员 —— 断言完马上撤掉，别在并行的 spec 的收件箱里多挂一条
      await admin.del("/api/v1/sys/notices", { pks: [pub.id] }).catch(() => {})
    }
  })

  test("🔴 阅读统计：开在 URL 上的抽屉，读者读了之后点刷新，已读 / 未读人数跟着变", async ({ authedPage: page }) => {
    const n = await publish({ audience: toUser("reads") })
    await page.goto(`/plugins/notice?reads=${n.id}&rtab=unread`)

    const sheet = page.locator('[data-tab="/_auth/plugins/notice"] [data-testid="notice-reads"]')
    await expect(sheet.getByTestId("notice-reads-title")).toHaveText(n.title)
    await expect(sheet.getByTestId("notice-reads-read-count")).toHaveText("0")
    await expect(sheet.getByTestId("notice-reads-unread-count")).toHaveText("1")
    await expect(sheet.locator(`[data-testid="notice-reads-row"][data-username="${users.reads.username}"]`)).toBeVisible()

    // 读者读一下（走和界面同一个口：PUT 收件箱那一行）
    const ctx = await request.newContext({ baseURL: API_BASE })
    try {
      const { token } = await loginToken(ctx, users.reads.username, PASSWORD)
      const headers = { Authorization: `Bearer ${token}` }
      const d = (await (await ctx.get(`${API_BASE}/api/v1/sys/notices/feed/${n.id}`, { headers })).json()) as {
        data: { notification_id: string }
      }
      const put = await ctx.put(`${API_BASE}/api/v1/sys/notifications/${d.data.notification_id}/read`, { headers })
      expect(put.ok()).toBeTruthy()
    } finally {
      await ctx.dispose()
    }

    await sheet.getByTestId("notice-reads-refresh").click()
    await expect(sheet.getByTestId("notice-reads-read-count")).toHaveText("1")
    await expect(sheet.getByTestId("notice-reads-unread-count")).toHaveText("0")

    // 换到「已读」页签：写进 URL（默认页签不写），名单里有他、带阅读时间
    await sheet.getByTestId("notice-reads-tab-read").click()
    await expect(page).not.toHaveURL(/rtab=/)
    await expect(page).toHaveURL(new RegExp(`[?&]reads=${n.id}(&|$)`))
    const row = sheet.locator(`[data-testid="notice-reads-row"][data-username="${users.reads.username}"]`)
    await expect(row).toContainText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)

    // 刷新整页：抽屉、页签都还在（硬纪律 2）
    await page.reload()
    await expect(sheet.getByTestId("notice-reads-read-count")).toHaveText("1")
    await expect(row).toBeVisible()
  })

  test("🔴 读者抽屉：从铃铛点开必须确认的公告不自动标已读，底部「我已阅读」；弹窗取不到也不挡路", async ({ page }) => {
    const must = await publish({ popup: true, requireAck: true, audience: toUser("ack") })
    // 弹窗接口挂了：不能挡住任何东西，人照样能从别处读到这条、在抽屉里确认
    await page.route(/\/api\/v1\/sys\/notices\/feed\/popups/, (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' })
    )
    await loginPageAs(page, users.ack.username, PASSWORD)
    await page.goto("/dashboard")

    // 🔴 走铃铛那一行：#190 之前点这一行就先 `readIfUnread` 了 —— 那个 PUT 就是显式已读，等于替人点了「我已阅读」
    await page.getByTestId("notification-bell").click()
    await page.getByTestId("notification-tab-announcement").click()
    await page.getByTestId("notification-item").filter({ hasText: must.title }).click()

    // 铃铛不在任何 tab 里，抽屉挂 <body>
    const reader = page.getByTestId("notice-reader")
    await expect(reader.getByTestId("notice-content")).toContainText(must.body)
    await expect(reader.getByTestId("notice-require-ack")).toBeVisible()
    await expect(page.getByTestId("notice-popup")).toHaveCount(0)

    // 普通公告此刻已经自动标掉了（详情回来 → PUT → 重取）；给它同样的时间，必须确认的要还是未读
    await page.waitForTimeout(1500)
    await expect(reader.getByTestId("notice-reader-ack")).toBeVisible()
    await expect(reader.getByTestId("notice-reader-acked")).toHaveCount(0)
    expect((await feedDetailAs(users.ack.username, must.id)).read).toBe(false)

    await reader.getByTestId("notice-reader-ack").click()
    await expect(reader.getByTestId("notice-reader-acked")).toBeVisible()
    expect((await feedDetailAs(users.ack.username, must.id)).read).toBe(true)
  })

  test("🔴 消息中心：必须确认的那一行不给「标记已读」；「全部已读」跳过它，确认框说清楚还剩几条要确认", async ({ page }) => {
    const must = await publish({ popup: true, requireAck: true, audience: toUser("inbox") })
    // 一条普通的：保证「全部已读」有东西可标（按钮才点得动），也用来证明它确实标掉了别的
    const plain = await publish({ audience: toUser("inbox") })
    // 必须确认的弹窗会盖住整个页面（只有「我已阅读」一个出口）—— 这条测的是收件箱，把弹窗接口挡掉（挡掉时不画，见 popup-host）
    await page.route(/\/api\/v1\/sys\/notices\/feed\/popups/, (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' })
    )
    const mustRow = (await feedDetailAs(users.inbox.username, must.id)).notification_id
    const plainRow = (await feedDetailAs(users.inbox.username, plain.id)).notification_id
    await loginPageAs(page, users.inbox.username, PASSWORD)
    await page.goto("/notification")
    const scope = page.locator('[data-tab="/_auth/notification"]')

    // 🔴 行操作：那个 PUT 就是后端认的「我已阅读」—— 必须确认的那一行换成一个说明原因的标记，普通的照旧有按钮
    await expect(scope.getByTestId(`notification-needs-ack-${mustRow}`)).toBeVisible()
    await expect(scope.getByTestId(`notification-read-${mustRow}`)).toHaveCount(0)
    await expect(scope.getByTestId(`notification-read-${plainRow}`)).toBeVisible()

    // 🔴 「全部已读」：确认框说清楚必须确认的不会被标；点完普通的标掉了，必须确认的还是未读
    await scope.getByTestId("notification-mark-all-page").click()
    await expect(page.getByTestId("confirm-dialog")).toContainText("另有 1 条必须确认的公告")
    await page.getByTestId("confirm-ok").click()
    await expect(scope.getByTestId(`notification-read-${plainRow}`)).toHaveCount(0)
    await expect(scope.getByTestId(`notification-needs-ack-${mustRow}`)).toBeVisible()
    expect((await feedDetailAs(users.inbox.username, plain.id)).read).toBe(true)
    expect((await feedDetailAs(users.inbox.username, must.id)).read).toBe(false)
    // 红点照亮（那条确实没读），按钮灰掉 —— 不再摆出「还有 1 条可以标」、点了却什么都不变
    await expect(page.getByTestId("notification-badge")).toBeVisible()
    await expect(scope.getByTestId("notification-mark-all-page")).toBeDisabled()
  })

  test("🔴 管理表单：「指定」一个都没选不让存；选了技术中心 + 弹窗 / 必读 → 列表上是「1 个部门」和两个标记，库里存的就是那个部门", async ({
    authedPage: page,
  }) => {
    const title = `E2E二期表单-${uniqueCode("NF")}`
    uiTitles.push(title)
    await page.goto("/plugins/notice")
    const tab = page.locator('[data-tab="/_auth/plugins/notice"]')
    await tab.getByTestId("add-notice").click()

    await page.getByTestId("n-title").fill(title)
    // 🔴 存成「隐藏」：不发收件箱、谁都看不到 —— 这条只验表单和列表，别让技术中心的人（别的 spec 在用）收到弹窗
    await page.getByTestId("n-status").click()
    await page.getByRole("option", { name: "隐藏" }).click()
    await page.getByTestId("n-content-content").locator(".ProseMirror").click()
    await page.keyboard.type("表单里写的正文")

    await page.getByTestId("n-audience-some").click()
    await page.getByTestId("n-submit").click()
    // 「指定」一个都没选 = `[]` = 全员，不能就这么发出去
    await expect(page.getByTestId("n-audience-error")).toBeVisible()

    // 「登录页可见」在有范围时是禁用的
    await expect(page.getByTestId("n-public")).toHaveAttribute("data-disabled", "")

    await page.getByTestId("n-audience-depts").click()
    await page.getByRole("option", { name: "技术中心", exact: true }).click()
    // 选了上级，下级显示成「随上级」、点不动
    await expect(page.getByRole("option", { name: /后端组/ })).toHaveAttribute("aria-disabled", "true")
    // 收起下拉别按 Esc：在抽屉里按会连抽屉一起关掉（workflow 分册「选人浮层别用 Esc 关」）
    await page.getByTestId("n-title").click()

    // 「必须确认」在弹窗关着时禁用；开弹窗之后才能开
    await expect(page.getByTestId("n-require-ack")).toHaveAttribute("data-disabled", "")
    await page.getByTestId("n-popup").click()
    await page.getByTestId("n-require-ack").click()

    await page.getByTestId("n-submit").click()
    await expect(page.getByTestId("n-submit")).toBeHidden()

    const list = (await admin.get(`/api/v1/sys/notices?page=1&size=5&title=${encodeURIComponent(title)}`)) as {
      items: { id: string; popup: boolean; require_ack: boolean; audience: { kind: string; target_id: string }[] }[]
    }
    const saved = list.items[0]!
    expect(saved.popup).toBe(true)
    expect(saved.require_ack).toBe(true)
    expect(saved.audience.map((a) => [a.kind, String(a.target_id)])).toEqual([["dept", techDeptId]])

    await expect(tab.getByTestId(`open-notice-${saved.id}`)).toBeVisible()
    // `has` 的内层定位是相对外层（这一行）查的 —— 不能再带 `[data-tab]` 前缀
    const row = tab.locator("tr").filter({ has: page.getByTestId(`open-notice-${saved.id}`) })
    await expect(row.getByTestId("notice-audience")).toHaveText("1 个部门")
    await expect(row.getByTestId(`notice-reach-${saved.id}`)).toContainText("弹窗")
    await expect(row.getByTestId("notice-require-ack")).toBeVisible()
  })
})
