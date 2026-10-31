import { request } from "@playwright/test"

import type { Page } from "@playwright/test"

import { API_BASE, createApiClient, expect, loginPageAs, loginToken, test } from "../fixtures/base"
import type { ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 工作台个性化（#202）：卡片按权限出现 · 编辑（显隐 / 键盘拖拽 / 宽度）· 存服务端、跨浏览器一样 · 恢复默认 ·
 * 存的布局里有认不出来的卡片照常渲染 · 读布局失败要看得见。
 *
 * 🔴 **全用非管理员**：admin 什么卡片都能用，「没权限的卡片不渲染」拿它测是假绿。账号是 `beforeAll` 现建的
 * 普通员工（普通员工角色没有日志 / 用户权限，正好是「只有人人都有的四张」那种人），**一条用例一个账号**：
 * 布局按人存，两条用例共用一个人会互相改对方的布局（文件里默认并行）。
 */

const PASSWORD = "Dash!123456"
const DASH = '[data-tab="/_auth/dashboard"]'
const PREF = "/api/v1/sys/users/me/preferences/dashboard.layout"
/** 普通员工的默认布局：人人都有的四张，按注册表顺序 */
const STAFF_DEFAULT = ["quick-links", "todo", "unread", "notices"]

const KEYS = ["default", "edit", "reset", "bogus", "broken", "savefail"] as const
type Key = (typeof KEYS)[number]

test.describe("工作台个性化 · 普通员工", () => {
  let admin: ApiClient
  let disposeAdmin: () => Promise<void>
  const users = {} as Record<Key, { id: string; username: string }>

  test.beforeAll(async () => {
    ;({ api: admin, dispose: disposeAdmin } = await createApiClient())
    type DeptNode = { id: string; name: string; children?: DeptNode[] }
    const tree = (await admin.get("/api/v1/sys/depts")) as DeptNode[]
    const flat: DeptNode[] = []
    const walk = (ns: DeptNode[]) => ns.forEach((n) => (flat.push(n), walk(n.children ?? [])))
    walk(tree)
    const deptId = (flat.find((d) => d.name === "市场运营中心") ?? flat[0])!.id
    const roles = (await admin.get("/api/v1/sys/roles/all")) as { id: string; name: string }[]
    const staffRole = roles.find((r) => r.name === "普通员工")!.id

    for (const key of KEYS) {
      const username = `dash_${key}_${uniqueCode("U").slice(2).toLowerCase()}`.slice(0, 30)
      const user = (await admin.post("/api/v1/sys/users", {
        username,
        password: PASSWORD,
        nickname: username,
        email: `${username}@e2e.example.com`,
        dept_id: deptId,
        roles: [staffRole],
      })) as { id: string }
      users[key] = { id: user.id, username }
    }
  })

  // 每条都是现建账号登录 + 整页加载（有的还要刷新 / 开第二个浏览器），忙的 CI 上 30 秒不够
  // （e2e 分册「四个把时间浪费掉的坑」最后一行）
  test.beforeEach(() => test.slow())

  test.afterAll(async () => {
    for (const u of Object.values(users)) await admin.del(`/api/v1/sys/users/${u.id}`).catch(() => {})
    await disposeAdmin()
  })

  /** 以某个人的身份直接存一份布局（造前置数据，不走界面） */
  async function putLayoutAs(key: Key, value: unknown) {
    const ctx = await request.newContext({ baseURL: API_BASE })
    try {
      const { token } = await loginToken(ctx, users[key].username, PASSWORD)
      const res = await ctx.put(`${API_BASE}${PREF}`, { headers: { Authorization: `Bearer ${token}` }, data: { value } })
      expect(res.ok(), await res.text()).toBeTruthy()
    } finally {
      await ctx.dispose()
    }
  }

  async function open(page: Page, key: Key) {
    await loginPageAs(page, users[key].username, PASSWORD)
    await page.goto("/dashboard")
  }

  /** 网格里**显示着**的卡片 id，按显示顺序 */
  const cardsIn = (page: Page) => page.locator(`${DASH} [data-testid="dash-grid"] > [data-testid^="dash-card-"]`)
  const shownIds = (page: Page) =>
    cardsIn(page).evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { testid: string } }).dataset.testid.slice("dash-card-".length)))

  async function expectCards(page: Page, ids: string[]) {
    await expect.poll(() => shownIds(page)).toEqual(ids)
  }

  /**
   * 键盘把编辑器里的一行挪到最上面（e2e 分册「键盘拖拽（dnd-kit）」那条）：先等「拿起来了」，
   * 再一下一下按 ↑，直到读屏播报说到了第 1 位才放下 —— 挪到顶上多按一下也不会过头
   */
  async function keyboardMoveToTop(page: Page, id: string, title: string) {
    const handle = page.locator(DASH).getByTestId(`dash-editor-handle-${id}`)
    await handle.focus()
    await page.keyboard.press("Space")
    await expect(handle).toHaveAttribute("aria-pressed", "true")
    const live = page.locator('[id^="DndLiveRegion"]')
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("ArrowUp")
      const said = await live.evaluate(
        (el) => new Promise<string>((resolve) => setTimeout(() => resolve(el.textContent ?? ""), 100))
      )
      if (said.includes(`「${title}」移到第 1 位`)) break
    }
    await page.keyboard.press("Space")
    await expect(handle).not.toHaveAttribute("aria-pressed", "true")
  }

  test("🔴 默认布局按权限算：普通员工只有「快捷入口 · 我的待办 · 未读消息 · 公告」，没有一张「没有权限」", async ({ page }) => {
    await open(page, "default")
    const dash = page.locator(DASH)

    // 先断言「应该看见的」（e2e 分册）：四张卡片按默认顺序、各自加载完
    await expectCards(page, STAFF_DEFAULT)
    for (const tid of ["dash-quick-links", "dash-todo", "dash-unread", "dash-notices"]) {
      await expect(dash.getByTestId(tid)).toBeVisible()
      await expect(dash.getByTestId(`${tid}-loading`)).toHaveCount(0)
    }
    // 快捷入口默认从他自己的侧边栏里取了几个页面
    await expect(dash.locator('[data-testid^="dash-quick-link-/"]').first()).toBeVisible()

    // 再断言「不该看见的」：管理员那几张不在、也没有任何一块「没有权限」/ 错误
    for (const tid of ["dash-metrics", "dash-trend", "dash-recent-logins", "dash-recent-operas", "metric-online-denied"]) {
      await expect(dash.getByTestId(tid)).toHaveCount(0)
    }
    await expect(dash.getByText("没有权限")).toHaveCount(0)
    await expect(dash.getByText("仅超级管理员可见")).toHaveCount(0)
    await expect(dash.locator('[role="alert"]')).toHaveCount(0)
  })

  test("🔴 隐藏一张 + 键盘拖一张到最前 + 改宽度 → 保存 → 刷新还在 → 换一个浏览器登同一个人也一样", async ({ page, browser }) => {
    await open(page, "edit")
    const dash = page.locator(DASH)
    await expectCards(page, STAFF_DEFAULT)

    await dash.getByTestId("dash-edit").click()
    // 编辑模式进 URL（硬纪律 2）
    await expect(page).toHaveURL(/[?&]edit=true/)
    const editor = dash.getByTestId("dash-editor")
    await expect(editor).toBeVisible()

    // 隐藏「未读消息」
    await editor.getByTestId("dash-editor-visible-unread").click()
    await expect(editor.getByTestId("dash-editor-row-unread")).toHaveAttribute("data-visible", "false")
    // 「公告」用键盘拖到最前
    await keyboardMoveToTop(page, "notices", "公告")
    // 「我的待办」改全宽
    await editor.getByTestId("dash-editor-width-todo-full").click()

    // 下面的网格是实时预览
    const expected = ["notices", "quick-links", "todo"]
    await expectCards(page, expected)
    await expect(dash.getByTestId("dash-card-todo")).toHaveAttribute("data-width", "full")

    await editor.getByTestId("dash-editor-save").click()
    await expect(editor).toBeHidden()
    await expect(page).not.toHaveURL(/[?&]edit=/)
    await expectCards(page, expected)

    // 刷新：只活在组件 state 里的话，这里就回到默认了
    await page.reload()
    await expectCards(page, expected)
    await expect(dash.getByTestId("dash-card-todo")).toHaveAttribute("data-width", "full")
    await expect(dash.getByTestId("dash-card-unread")).toHaveCount(0)

    // 换一个浏览器上下文（= 另一台设备）登同一个人：布局在服务端，不在这台机器的 localStorage 里
    const ctx = await browser.newContext()
    try {
      const other = await ctx.newPage()
      await open(other, "edit")
      await expectCards(other, expected)
      await expect(other.locator(DASH).getByTestId("dash-card-todo")).toHaveAttribute("data-width", "full")
    } finally {
      await ctx.close()
    }
  })

  test("🔴 恢复默认：存过的布局 → 编辑里点「恢复默认」→ 保存 → 刷新是默认布局", async ({ page }) => {
    await putLayoutAs("reset", {
      v: 1,
      cards: [
        { id: "unread", visible: true, width: "full" },
        { id: "notices", visible: false, width: "full" },
        { id: "todo", visible: true, width: "full" },
        { id: "quick-links", visible: false, width: "full" },
      ],
    })
    await open(page, "reset")
    const dash = page.locator(DASH)
    // 先确认存的那份真的生效了（否则「恢复之后是默认」在什么都没存时也成立）
    await expectCards(page, ["unread", "todo"])

    await dash.getByTestId("dash-edit").click()
    await dash.getByTestId("dash-editor-reset").click()
    await expectCards(page, STAFF_DEFAULT)
    await dash.getByTestId("dash-editor-save").click()
    await expect(dash.getByTestId("dash-editor")).toBeHidden()

    await page.reload()
    await expectCards(page, STAFF_DEFAULT)
    await expect(dash.getByTestId("dash-card-todo")).toHaveAttribute("data-width", "half")
  })

  test("🔴 存的布局里有不存在的卡片 id / 没权限的卡片：忽略它们，页面照常；新卡片按默认排到最后", async ({ page }) => {
    await putLayoutAs("bogus", {
      v: 1,
      cards: [
        { id: "no-such-card", visible: true, width: "full" },
        // 普通员工没有日志权限：存了也不能出现
        { id: "recent-logins", visible: true, width: "full" },
        { id: "notices", visible: true, width: "half" },
        { id: "unread", visible: false, width: "half" },
      ],
    })
    await open(page, "bogus")
    const dash = page.locator(DASH)

    // 存的那两张在前（显隐 / 宽度照存的），存的里面没有的按默认排到最后
    await expectCards(page, ["notices", "quick-links", "todo"])
    await expect(dash.getByTestId("dash-card-notices")).toHaveAttribute("data-width", "half")
    await expect(dash.getByTestId("dash-notices")).toBeVisible()
    await expect(dash.getByTestId("dash-recent-logins")).toHaveCount(0)
    await expect(dash.getByTestId("dash-layout-unreadable")).toHaveCount(0)
    await expect(dash.getByTestId("dash-layout-error")).toHaveCount(0)
  })

  test("🔴 读布局失败：显示错误 + 默认布局、不能编辑；重试成功换回他自己的布局", async ({ page }) => {
    await putLayoutAs("broken", { v: 1, cards: [{ id: "notices", visible: true, width: "half" }] })
    let fail = true
    // 只拦读布局那一个 GET（硬纪律 9：不能静默退回默认还假装是他的布局）
    await page.route(
      (url) => url.pathname.endsWith("/sys/users/me/preferences/dashboard.layout"),
      (route) =>
        fail && route.request().method() === "GET"
          ? route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' })
          : route.fallback()
    )
    await open(page, "broken")
    const dash = page.locator(DASH)

    const banner = dash.getByTestId("dash-layout-error")
    await expect(banner).toBeVisible()
    await expectCards(page, STAFF_DEFAULT)
    // 读不到他存的那份时不许编辑：存下去就是拿默认布局覆盖他服务端那份
    await expect(dash.getByTestId("dash-edit")).toBeDisabled()

    fail = false
    await banner.getByRole("button").click()
    await expect(banner).toBeHidden()
    await expectCards(page, ["notices", "quick-links", "todo", "unread"])
    await expect(dash.getByTestId("dash-card-notices")).toHaveAttribute("data-width", "half")
    await expect(dash.getByTestId("dash-edit")).toBeEnabled()
  })

  test("🔴 菜单 / 权限还没到齐时是骨架，不是先闪一下「所有卡片都隐藏了」", async ({ page }) => {
    // 侧边栏慢 3 秒（布局本身先回来了）：能用哪些卡片要等它，等的这段时间不能拿「空集合」去合并布局
    let sidebarDone = false
    await page.route(/\/api\/v1\/sys\/menus\/sidebar/, async (route) => {
      await new Promise((r) => setTimeout(r, 3000))
      await route.fallback()
      sidebarDone = true
    })
    await loginPageAs(page, users.default.username, PASSWORD)
    const prefArrived = page.waitForResponse((r) => r.url().includes("/preferences/dashboard.layout"))
    await page.goto("/dashboard")
    await prefArrived
    // 先确认窗口真的存在：布局回来了、侧边栏还没回来（否则下面的断言什么都没验）
    expect(sidebarDone, "侧边栏比布局先回来了，这条用例没造出要验的那个窗口").toBe(false)
    // 🔴 这里刻意等一小段再数，不用会自动重试的断言：要验的是「这段时间里一次都没出现」，
    // 而 `toHaveCount(0)` 一上来就满足、立刻通过 —— 第一版就是那么写的，把修复改回去照样绿
    await page.waitForTimeout(500)
    const dash = page.locator(DASH)
    expect(sidebarDone).toBe(false)
    expect(await dash.getByTestId("dash-empty").count(), "侧边栏没到就拿空集合合并了布局").toBe(0)
    expect(await dash.getByTestId("dash-loading").count()).toBe(1)
    await expectCards(page, STAFF_DEFAULT)
  })

  test("🔴 保存失败：错误留在编辑器里、还在编辑模式、改动没丢（不能装成「已保存」退出去）", async ({ page }) => {
    await open(page, "savefail")
    const dash = page.locator(DASH)
    await expectCards(page, STAFF_DEFAULT)
    await page.route(
      (url) => url.pathname.endsWith("/sys/users/me/preferences/dashboard.layout"),
      (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' })
          : route.fallback()
    )

    await dash.getByTestId("dash-edit").click()
    const editor = dash.getByTestId("dash-editor")
    await editor.getByTestId("dash-editor-visible-notices").click()
    const edited = ["quick-links", "todo", "unread"]
    await expectCards(page, edited)

    await editor.getByTestId("dash-editor-save").click()
    await expect(editor.getByTestId("dash-editor-save-error")).toBeVisible()
    await expect(page).toHaveURL(/[?&]edit=true/)
    await expectCards(page, edited)
  })
})
