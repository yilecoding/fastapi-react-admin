import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 多页签保活（`<Activity>`）—— 这个仓库唯一没有库背书、纯自己写的机制，
 * 回归价值最高的地方。见 CLAUDE.md 硬纪律 1/4/5。
 *
 * 切 tab 必须走**真实的客户端路由导航**（点页面里的 `<Link>`），不能用
 * `page.goto()` 连续导航两次——那是整页刷新，会把 React 运行时重启一遍，
 * 「状态还在」这件事就变得毫无意义（不是因为 Activity 保活，只是因为凑巧没刷新）。
 *
 * 🔴 测的不是「新增部门」抽屉里的草稿——抽屉是模态 Sheet，遮罩挡住整个视口，
 * 开着它根本点不到侧边栏，切 tab 这个动作在真实用户手里就做不出来（实测确认过：
 * 点侧边栏链接直接超时，「subtree intercepts pointer events」）。测的是树形展开状态——
 * `useTreeFold` 明确不进 URL（细粒度状态留组件 state，见那个文件的头注释），
 * 是真正只靠 Activity 保活、没有别的持久层兜底的东西。
 *
 * 下面第一条测试实测抓到过一个真 bug：`useTreeFold` 的 `useEffect` 在 Activity
 * 从隐藏切回可见时会被整个销毁重建，一个新建的 effect 不管依赖数组内容是什么、
 * 首次挂载都会跑一次——于是每次切一次 tab 回来，它都会误判成「foldAll 变了」，
 * 把手动折叠的节点清空。已经在 `_shared/use-tree-fold.ts` 里修掉（用 ref 记住
 * 上一次真正生效的值再比对）。这条测试就是那次修复的回归。
 */
test.describe("多页签保活", () => {
  test("切走再切回来，手动折叠的节点状态还在", async ({ authedPage: page, api }) => {
    const code = uniqueCode("E2ETAB")
    const parentName = `E2E保活父${code}`
    const childName = `E2E保活子${code}`

    await api.post("/api/v1/sys/depts", { code, name: parentName, status: 1, sort: 0 })
    const [parent] = (await api.get(`/api/v1/sys/depts?code=${code}`)) as Array<{ id: string }>
    await api.post("/api/v1/sys/depts", {
      code: `${code}C`,
      name: childName,
      status: 1,
      sort: 0,
      parent_id: parent.id,
    })

    try {
      await page.goto("/system/dept")
      // 默认是展开的，子节点先确认可见，再手动折叠父节点
      await expect(page.getByTestId(`dept-row-${childName}`)).toBeVisible()
      await page.getByTestId(`dept-toggle-${parentName}`).click()
      await expect(page.getByTestId(`dept-row-${childName}`)).not.toBeVisible()

      // 切到角色管理这个 tab —— 客户端路由，部门管理那个 tab 应该被 <Activity> 隐藏
      // 而不是卸载
      await page.locator('a[href="/system/role"]').first().click()
      await expect(page.locator('[data-tab*="/_auth/system/role"] [data-testid="page-title"]')).toHaveText(
        "角色管理"
      )

      // 切回去：折叠状态要还在，子节点仍然不可见
      await page.locator('a[href="/system/dept"]').first().click()
      await expect(page.locator('[data-tab*="/_auth/system/dept"] [data-testid="page-title"]')).toHaveText(
        "部门管理"
      )
      await expect(page.getByTestId(`dept-row-${childName}`)).not.toBeVisible()
      await expect(page.getByTestId(`dept-row-${parentName}`)).toBeVisible()
    } finally {
      const child = (await api.get(`/api/v1/sys/depts?code=${code}C`)) as Array<{ id: string }>
      for (const c of child) await api.del(`/api/v1/sys/depts/${c.id}`)
      await api.del(`/api/v1/sys/depts/${parent.id}`)
    }
  })

  test("隐藏 tab 的 DOM 还在文档树里，只是标了 data-visible=false", async ({ authedPage: page }) => {
    await page.goto("/system/dept")
    await page.locator('a[href="/system/role"]').first().click()
    await expect(page.locator('[data-tab*="/_auth/system/role"] [data-testid="page-title"]')).toHaveText(
      "角色管理"
    )

    const deptFrame = page.locator('[data-tab*="/_auth/system/dept"]')
    const roleFrame = page.locator('[data-tab*="/_auth/system/role"]')

    await expect(roleFrame).toHaveAttribute("data-visible", "true")
    await expect(deptFrame).toHaveAttribute("data-visible", "false")
    // 硬纪律 5 讲的就是这个 —— 不能只按 [data-visible=true] 找页面，
    // 隐藏 tab 的 DOM 没被卸载，两个 frame 都在文档树里
    await expect(deptFrame).toBeAttached()
  })
})
