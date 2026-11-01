import { request } from "@playwright/test"

import type { Page } from "@playwright/test"

import { API_BASE, createApiClient, expect, loginPageAs, loginToken, test } from "../fixtures/base"
import type { ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 工作台（#202）：卡片按权限出现 · 编辑（显隐 / 键盘拖拽 / 宽度）· 存服务端、跨浏览器一样 · 恢复默认 ·
 * 存的布局里有认不出来的卡片照常渲染 · 读布局失败要看得见 · 「待我处理」/「我发起的」用真数据 · 系统运行区只给管理员。
 *
 * 🔴 **员工视图全用非管理员**：admin 什么卡片都能用，「没权限的卡片不渲染」拿它测是假绿。账号是 `beforeAll` 现建的
 * 普通员工（普通员工角色没有日志 / 任务 / 开放平台权限，也不是超管 —— 正好一张系统运行区的卡片都没有），
 * **一条用例一个账号**：布局按人存，两条用例共用一个人会互相改对方的布局（文件里默认并行）。
 */

const PASSWORD = "Dash!123456"
const DASH = '[data-tab="/_auth/dashboard"]'
const PREF = "/api/v1/sys/users/me/preferences/dashboard.layout"
/** 普通员工的默认布局（按注册表顺序）。「公告」默认不显示，所以不在里面 */
const STAFF_DEFAULT = ["todo", "initiated", "quick-start", "quick-links", "unread"]
/** 系统运行区的三张，员工一张都不该有 */
const SYSTEM_CARDS = ["attention", "services", "visits"]

const KEYS = ["default", "edit", "reset", "bogus", "unreadable", "broken", "savefail", "approver", "initiator"] as const
type Key = (typeof KEYS)[number]

test.describe("工作台个性化 · 普通员工", () => {
  let admin: ApiClient
  let disposeAdmin: () => Promise<void>
  const users = {} as Record<Key, { id: string; username: string }>
  /** 真数据那条现建的流程定义：有过实例的删不掉，收尾时停用 —— 不然每跑一轮，所有人的「快速发起」里就多一个 */
  const definitions: string[] = []

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
    for (const id of definitions) {
      await admin.put(`/api/v1/sys/workflow/definitions/${id}/status`, { enabled: false }).catch(() => {})
    }
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

  test("🔴 默认布局按权限算：普通员工是「待我处理 · 我发起的 · 快速发起 · 常用入口 · 和我有关的消息」，没有系统运行区", async ({ page }) => {
    await open(page, "default")
    const dash = page.locator(DASH)

    // 先断言「应该看见的」（e2e 分册）：五张卡片按默认顺序、各自加载完
    await expectCards(page, STAFF_DEFAULT)
    for (const id of STAFF_DEFAULT) {
      await expect(dash.getByTestId(`dash-${id}`)).toBeVisible()
      await expect(dash.getByTestId(`dash-${id}-loading`)).toHaveCount(0)
    }
    await expect(dash.getByTestId("dash-card-todo")).toHaveAttribute("data-width", "two-thirds")
    // 常用入口默认从他自己的侧边栏里取了几个页面
    await expect(dash.locator('[data-testid^="dash-quick-link-/"]').first()).toBeVisible()
    // 新账号手上什么都没有：大标题说平静的那句，不是「你有 0 件事」
    await expect(dash.getByTestId("dash-headline")).toHaveText("手上没有要处理的事")

    // 再断言「不该看见的」：系统运行区整块不在（连标题行都没有）、公告默认不显示、也没有任何一块「没有权限」/ 错误
    await expect(dash.getByTestId("dash-system")).toHaveCount(0)
    for (const id of [...SYSTEM_CARDS, "notices"]) {
      await expect(dash.getByTestId(`dash-card-${id}`)).toHaveCount(0)
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

    // 员工的编辑器里只有「我的工作」那一组
    await expect(editor.getByTestId("dash-editor-list-system")).toHaveCount(0)
    // 隐藏「和我有关的消息」
    await editor.getByTestId("dash-editor-visible-unread").click()
    await expect(editor.getByTestId("dash-editor-row-unread")).toHaveAttribute("data-visible", "false")
    // 打开默认隐藏的「公告」，再用键盘拖到最前
    await editor.getByTestId("dash-editor-visible-notices").click()
    await keyboardMoveToTop(page, "notices", "公告")
    // 「待我处理」改整行
    await editor.getByTestId("dash-editor-width-todo-full").click()

    // 下面的网格是实时预览
    const expected = ["notices", "todo", "initiated", "quick-start", "quick-links"]
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
        { id: "notices", visible: true, width: "full" },
        { id: "todo", visible: true, width: "full" },
        { id: "initiated", visible: false, width: "full" },
        { id: "quick-start", visible: false, width: "full" },
        { id: "quick-links", visible: false, width: "full" },
      ],
    })
    await open(page, "reset")
    const dash = page.locator(DASH)
    // 先确认存的那份真的生效了（否则「恢复之后是默认」在什么都没存时也成立）
    await expectCards(page, ["unread", "notices", "todo"])

    await dash.getByTestId("dash-edit").click()
    await dash.getByTestId("dash-editor-reset").click()
    await expectCards(page, STAFF_DEFAULT)
    await dash.getByTestId("dash-editor-save").click()
    await expect(dash.getByTestId("dash-editor")).toBeHidden()

    await page.reload()
    await expectCards(page, STAFF_DEFAULT)
    await expect(dash.getByTestId("dash-card-todo")).toHaveAttribute("data-width", "two-thirds")
  })

  test("🔴 存的布局里有不存在的卡片 id / 没权限的卡片：忽略它们，页面照常；新卡片按默认排到最后", async ({ page }) => {
    await putLayoutAs("bogus", {
      v: 1,
      cards: [
        { id: "no-such-card", visible: true, width: "full" },
        // 普通员工没有登录日志权限：存了也不能出现（也不能因为它画出系统运行那一行标题）
        { id: "visits", visible: true, width: "full" },
        { id: "notices", visible: true, width: "half" },
        { id: "unread", visible: false, width: "half" },
      ],
    })
    await open(page, "bogus")
    const dash = page.locator(DASH)

    // 存的那两张在前（显隐 / 宽度照存的），存的里面没有的按默认排到最后
    await expectCards(page, ["notices", "todo", "initiated", "quick-start", "quick-links"])
    await expect(dash.getByTestId("dash-card-notices")).toHaveAttribute("data-width", "half")
    await expect(dash.getByTestId("dash-notices")).toBeVisible()
    await expect(dash.getByTestId("dash-visits")).toHaveCount(0)
    await expect(dash.getByTestId("dash-system")).toHaveCount(0)
    await expect(dash.getByTestId("dash-layout-unreadable")).toHaveCount(0)
    await expect(dash.getByTestId("dash-layout-error")).toHaveCount(0)
  })

  test("🔴 存的布局整份认不出来：提示 + 默认布局；不改任何东西也能直接保存，把坏数据覆盖掉", async ({ page }) => {
    await putLayoutAs("unreadable", "这不是一份布局")
    await open(page, "unreadable")
    const dash = page.locator(DASH)
    await expect(dash.getByTestId("dash-layout-unreadable")).toBeVisible()
    await expectCards(page, STAFF_DEFAULT)

    await dash.getByTestId("dash-edit").click()
    // 提示说的就是「编辑并保存一次就会覆盖它」—— 非要先改点什么才能存的话，坏数据就一直覆盖不掉
    const save = dash.getByTestId("dash-editor-save")
    await expect(save).toBeEnabled()
    await save.click()
    await expect(dash.getByTestId("dash-editor")).toBeHidden()

    await page.reload()
    await expectCards(page, STAFF_DEFAULT)
    await expect(dash.getByTestId("dash-layout-unreadable")).toHaveCount(0)
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
    await expectCards(page, ["notices", ...STAFF_DEFAULT])
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
    await editor.getByTestId("dash-editor-visible-unread").click()
    const edited = ["todo", "initiated", "quick-start", "quick-links"]
    await expectCards(page, edited)

    await editor.getByTestId("dash-editor-save").click()
    await expect(editor.getByTestId("dash-editor-save-error")).toBeVisible()
    await expect(page).toHaveURL(/[?&]edit=true/)
    await expectCards(page, edited)
  })
  test("🔴 待我处理用真数据：加急在前 · 超时胶囊照动作出字 · 「处理」就地开审批单 · 分段进 URL；发起人那边是带名字的步骤条", async ({
    page,
    browser,
  }) => {
    // 两步的流程：第一步给「approver」（48 小时不办自动同意），第二步给赵磊；「initiator」发两张，后一张加急
    const code = uniqueCode("E2EDASH")
    const step = (id: string, name: string, userId: string, next: unknown, timeout?: unknown) => ({
      type: "approval",
      id,
      name,
      mode: "any",
      assignee: { kind: "user", user_ids: [userId] },
      onEmpty: "reject",
      fieldPerms: {},
      ...(timeout ? { timeout } : {}),
      next,
    })
    const found = (await admin.get("/api/v1/sys/users?page=1&size=20&username=zhaolei")) as {
      items: { id: string; username: string }[]
    }
    const zhaolei = found.items.find((u) => u.username === "zhaolei")!.id
    const def = (await admin.post("/api/v1/sys/workflow/definitions", {
      code,
      name: `E2E 采购 ${code}`,
      form: { schemaVersion: 1, fields: [{ id: "f", type: "text", label: "事由" }] },
      model: {
        schemaVersion: 1,
        root: {
          type: "start",
          id: "start",
          next: step("n1", "部门初审", users.approver.id, step("n2", "财务复核", zhaolei, null), { hours: 48, action: "approve" }),
        },
      },
    })) as { id: string }
    definitions.push(def.id)
    await admin.post(`/api/v1/sys/workflow/definitions/${def.id}/publish`)

    const ctx = await request.newContext({ baseURL: API_BASE })
    const ids: string[] = []
    try {
      const { token } = await loginToken(ctx, users.initiator.username, PASSWORD)
      for (const [reason, urgent, k] of [["普通的一张", false, "plain"], ["加急的一张", true, "urgent"]] as const) {
        const res = await ctx.post(`${API_BASE}/api/v1/sys/workflow/instances`, {
          headers: { Authorization: `Bearer ${token}` },
          data: { code, form: { f: reason }, urgent, key: `${code}-${k}` },
        })
        const body = (await res.json()) as { data: { instance_id: string } }
        expect(res.ok(), JSON.stringify(body)).toBeTruthy()
        ids.push(body.data.instance_id)
      }
    } finally {
      await ctx.dispose()
    }
    const [plain, urgent] = ids as [string, string]

    // ── 审批人 ──
    await open(page, "approver")
    const dash = page.locator(DASH)
    await expect(dash.getByTestId("dash-headline")).toHaveAttribute("data-total", "2")
    await expect(dash.getByTestId("dash-headline")).toHaveText("你有 2 件事等着处理，其中 1 件加急")
    const rows = dash.locator('[data-testid="dash-todo-list"] > li')
    await expect(rows).toHaveCount(2)
    // 加急的后发，但排在前面（后端 sort=attention）
    await expect(rows.nth(0)).toHaveAttribute("data-urgent", "true")
    await expect(rows.nth(1)).toHaveAttribute("data-urgent", "false")
    // 节点配的是「48 小时后自动同意」：胶囊照动作说，不是一律「快到期」
    await expect(rows.nth(0).getByTestId("dash-todo-due")).toContainText("后自动同意")
    await expect(dash.getByTestId("dash-todo-count-approve")).toHaveText("2")
    await expect(dash.getByTestId("dash-todo-count-back")).toHaveText("0")

    // 「处理」就地开审批单（URL 带上 wf，硬纪律 2），不跳到审批中心
    await rows.nth(0).getByTestId("dash-todo-action").click()
    await expect(page).toHaveURL(new RegExp(`[?&]wf=${urgent}`))
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByTestId("wf-instance-sheet")).toBeVisible()
    await expect(page.getByTestId("wf-instance-sheet").getByTestId("wf-act-approve")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page).not.toHaveURL(/[?&]wf=/)

    // 分段进 URL：切到「草稿」→ 刷新还在「草稿」
    await dash.getByTestId("dash-todo-tab-draft").click()
    await expect(page).toHaveURL(/[?&]todo=draft/)
    await expect(dash.getByTestId("dash-todo-empty")).toBeVisible()
    await page.reload()
    await expect(dash.getByTestId("dash-todo-tab-draft")).toHaveAttribute("aria-selected", "true")
    await dash.getByTestId("dash-todo-tab-all").click()
    await expect(page).not.toHaveURL(/[?&]todo=/)
    await expect(rows).toHaveCount(2)

    // ── 发起人：「我发起的」里两张都在第一步，步骤条画出 发起 ✓ · 审批人（当前）· 赵磊（后面那步，推演出来的）。
    //    一步只有一个人办时写人名、多人写节点名（同设计稿「发起 → 赵磊 → 财务」）──
    const other = await browser.newContext()
    try {
      const p2 = await other.newPage()
      await open(p2, "initiator")
      const item = p2.locator(DASH).getByTestId(`dash-initiated-${plain}`)
      await expect(item).toBeVisible()
      await expect(item.getByTestId("dash-initiated-status")).toHaveText("审批中")
      const steps = item.getByTestId("dash-initiated-steps")
      await expect(steps.locator('[data-state="start"]')).toHaveText("发起")
      await expect(steps.locator('[data-state="current"]')).toHaveText(users.approver.username)
      await expect(steps.locator('[data-state="next"]')).toHaveText(["赵磊"])
      await expect(item).toContainText("手上")
      // 刚发起的单还没等够一天，不给「催办」
      await expect(item.getByTestId("dash-initiated-remind")).toHaveCount(0)
    } finally {
      await other.close()
    }
  })
})

test.describe("工作台 · 系统运行区（管理员）", () => {
  test("🔴 超管看得到「系统运行」：需要你留意 · 服务状态 · 近 14 天访问，三块各自加载完、没有错误块", async ({ page, api }) => {
    test.slow()
    // admin 在这个库里可能存过布局（别的会话 / 截图脚本）：先存一份空的，等于「全按默认」
    await api.put("/api/v1/sys/users/me/preferences/dashboard.layout", { value: { v: 1, cards: [] } })
    await loginPageAs(page, "admin", "123456")
    await page.goto("/dashboard")
    const dash = page.locator(DASH)

    const system = dash.getByTestId("dash-system")
    await expect(system).toBeVisible()
    await expect(system).toContainText("仅管理员可见")
    await expect
      .poll(() =>
        system
          .locator('[data-testid="dash-grid-system"] > [data-testid^="dash-card-"]')
          .evaluateAll((els) => els.map((e) => (e as unknown as { dataset: { testid: string } }).dataset.testid))
      )
      .toEqual(SYSTEM_CARDS.map((id) => `dash-card-${id}`))
    for (const id of SYSTEM_CARDS) {
      await expect(dash.getByTestId(`dash-${id}`)).toBeVisible()
      await expect(dash.getByTestId(`dash-${id}-loading`)).toHaveCount(0)
      await expect(dash.getByTestId(`dash-${id}-error`)).toHaveCount(0)
    }
    // 服务状态：五个服务一行一个（E2E 环境没起 worker / beat，所以结论不一定是「全部正常」—— 只验它画出了结论）
    await expect(dash.locator('[data-testid^="dash-service-"]')).toHaveCount(5)
    await expect(dash.getByTestId("dash-services-summary")).toBeVisible()
    await expect(dash.getByTestId("dash-sessions-total")).not.toHaveText("—")
    // 近 14 天：14 组柱子，最后一组是今天（「哪一天」按显示时区切）
    await expect(dash.getByTestId("dash-visits-day")).toHaveCount(14)
    await expect(dash.getByTestId("dash-system-updated")).toBeVisible()
    // 管理员的待办和员工是同一个组件
    await expect(dash.getByTestId("dash-todo")).toBeVisible()
  })
})
