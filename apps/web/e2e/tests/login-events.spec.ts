import { API_BASE, expect, test } from "../fixtures/base"

/**
 * 登录日志里的安全事件（#273）：密码连续输错 → 账号被锁 → 登录日志按「事件」筛得出那一行。
 *
 * 筛选条件从地址栏进（`event=locked`）：路由 schema、查询区、接口入参三层少一层，
 * 表现都是「筛了等于没筛」—— 这里断言只剩被锁那一行、而且显示的是事件名，不是「失败」
 */
test.describe("登录安全事件", () => {
  test("密码连续输错被锁 → 登录日志按「账号被锁」筛出来", async ({ authedPage: page, api, request }) => {
    const username = `e2e_lock_${Date.now().toString(36)}`
    const depts = (await api.get("/api/v1/sys/depts")) as { id: string }[]
    const roles = (await api.get("/api/v1/sys/roles/all")) as { id: string }[]
    const user = (await api.post("/api/v1/sys/users", {
      username,
      password: "E2eLock@123456",
      nickname: "锁定",
      dept_id: depts[0].id,
      roles: [roles[0].id],
    })) as { id: string }
    try {
      // 阈值是参数配置里的 USER_LOCK_THRESHOLD（种子 5）；多试几次也只该有一行「被锁」。
      // 🔴 走真登录接口，不走 swagger 调试口：后者**不写登录日志** —— 那样这个人名下只有「被锁」一行，
      // 筛不筛都是一行，这条测试什么都没验（变异检验时抓到的）
      for (let i = 0; i < 6; i++) {
        await request.post(`${API_BASE}/api/v1/auth/login`, {
          data: { username, password: "definitely-wrong" },
        })
      }

      await page.goto(`/log/login?event=locked&username=${username}`)
      const tab = page.locator('[data-tab="/_auth/log/login"]')
      const table = tab.getByTestId("login-table")
      await expect(table).toHaveAttribute("data-fetching", "false")
      const rows = table.locator("tbody tr")
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).toContainText("账号被锁")
      await expect(rows.first()).toContainText("锁定")
    } finally {
      await api.del(`/api/v1/sys/users/${user.id}`).catch(() => undefined)
    }
  })
})
