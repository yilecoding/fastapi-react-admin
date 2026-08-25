import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 换身份必须清掉标签页（issue #29 的回归）。
 *
 * 🔴 这条只能用**两个权限不同的账号**来测：同一个账号退出再登录，权限一样，
 * 标签条留不留都看不出问题。所以这里现造一个「只绑仪表盘菜单」的账号 ——
 * 它的侧边栏只有一项，标签条上如果还挂着「部门管理」，那就是上一个人的残留。
 *
 * 也不能用 `authedPage`：它靠 `addInitScript` 在每次导航前注入 admin 的 token，
 * 而这条测试要走的正是**真实的退出 + 换账号登录**（验证码在 global-setup 里已关）。
 */
const PASSWORD = "Sess!123456"

test.describe("换身份", () => {
  test("退出登录清掉标签页，换一个权限更小的账号不会带上一个人的 tab", async ({ page, api }) => {
    const sfx = uniqueCode("SESS")
    const username = `sess_${sfx.toLowerCase()}`

    // ── 造一个只有「仪表盘」的账号 ──
    type MenuNode = { id: string; path: string | null; children?: MenuNode[] }
    const menus = (await api.get("/api/v1/sys/menus")) as MenuNode[]
    const flat: MenuNode[] = []
    const walk = (ns: MenuNode[]) => ns.forEach((n) => { flat.push(n); walk(n.children ?? []) })
    walk(menus)
    const dashboard = flat.find((m) => m.path === "/dashboard")
    const roleName = `E2E换身份角色-${sfx}`
    await api.post("/api/v1/sys/roles", {
      code: uniqueCode("E2ESESS"), name: roleName, status: 1, is_filter_scopes: true, remark: null,
    })
    const roles = (await api.get("/api/v1/sys/roles/all")) as Array<{ id: string; name: string }>
    const role = roles.find((r) => r.name === roleName)
    if (!role) throw new Error(`角色建完却找不到：${roleName}`)
    await api.put(`/api/v1/sys/roles/${role.id}/menus`, { menus: dashboard ? [dashboard.id] : [] })
    const depts = (await api.get("/api/v1/sys/depts")) as Array<{ id: string }>
    const user = (await api.post("/api/v1/sys/users", {
      username, password: PASSWORD, nickname: username,
      email: `${username}@e2e.example.com`, dept_id: depts[0].id, roles: [role.id],
    })) as { id: string }

    try {
      // ── admin 登录并开两个高权限页面 ──
      await page.goto("/sign-in")
      await page.getByTestId("username").fill("admin")
      await page.getByTestId("password").fill("123456")
      await page.getByTestId("submit").click()
      await expect(page).toHaveURL(/\/dashboard/)

      await page.goto("/system/dept")
      await page.goto("/plugins/config")
      const bar = page.getByTestId("tab-bar")
      await expect(bar).toContainText("部门管理")
      await expect(bar).toContainText("参数配置")

      // ── 退出：标签页当场就该空，不是等下一次登录才清 ──
      await page.getByTestId("user-menu").click()
      await page.getByTestId("logout").click()
      await expect(page).toHaveURL(/\/sign-in/)
      const stored = await page.evaluate(() => sessionStorage.getItem("admin:tabs"))
      expect(JSON.parse(stored ?? '{"state":{"tabs":[]}}').state.tabs).toEqual([])

      // ── 换成只有仪表盘的账号 ──
      await page.getByTestId("username").fill(username)
      await page.getByTestId("password").fill(PASSWORD)
      await page.getByTestId("submit").click()
      await expect(page).toHaveURL(/\/dashboard/)

      await expect(bar).toContainText("仪表盘")
      // 关键断言：上一个人的页面一个都不能在
      await expect(bar).not.toContainText("部门管理")
      await expect(bar).not.toContainText("参数配置")
      // 页面本体也不能还挂在文档树里（隐藏 tab 的 DOM 也在，见硬纪律 5）
      await expect(page.locator('[data-tab="/_auth/system/dept"]')).toHaveCount(0)
      await expect(page.locator('[data-tab="/_auth/plugins/config"]')).toHaveCount(0)
    } finally {
      await api.del("/api/v1/sys/users", { pks: [user.id] }).catch(() => {})
      await api.del("/api/v1/sys/roles", { pks: [role.id] }).catch(() => {})
    }
  })

  test("无权访问页进标签条时要有名字，不是裸 /403", async ({ authedPage: page }) => {
    // 语言包里 `menu:/403` 曾经被写成字面量 "/403"（en-US 是 Access denied），
    // 于是中文界面上这个 tab 显示成一段路径
    await page.goto("/403?from=/system/dept&need=sys:dept:add")
    const bar = page.getByTestId("tab-bar")
    await expect(bar).toContainText("无权访问")
    await expect(bar).not.toContainText("/403")
  })
})
