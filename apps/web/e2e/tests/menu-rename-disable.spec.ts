import { readFileSync } from "node:fs"
import path from "node:path"

import { expect, test, type ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * #143：菜单管理里两处「改了、保存成功、界面不变」。
 *
 * - **改内置菜单的标题**：原来所有显示菜单名的地方都先按路由地址查语言包，内置菜单两个语言包里都有译名，
 *   库里的新标题永远轮不到。现在中文界面以库为准（`@admin/i18n: menuTitle`），英文界面仍是内置译名。
 *   标签条要单独盯：标签自己存的标题是打开那一刻定下的，已经开着的标签得现查菜单树才会变
 * - **停用一个目录**：原来侧边栏只看「是否显示」，停用了照样显示。现在整枝不下发
 *
 * 两条都改的是种子里的真菜单，`finally` 里原样改回去 —— `fba_test` 是 pytest 和 E2E 共用的库。
 */

type Menu = { id: string; title: string; path: string | null; children?: Menu[] }
type MenuDetail = Menu & Record<string, unknown>

const WRITABLE = ["title", "name", "path", "parent_id", "sort", "icon", "type", "perms", "status", "display", "link", "remark"]

const EN = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../../packages/i18n/src/locales/en-US.json"), "utf8")
) as Record<string, string>

async function findByPath(api: ApiClient, p: string): Promise<Menu> {
  const flat = (ms: Menu[]): Menu[] => ms.flatMap((m) => [m, ...flat(m.children ?? [])])
  const hit = flat((await api.get("/api/v1/sys/menus")) as Menu[]).find((m) => m.path === p)
  if (!hit) throw new Error(`前置：种子里要有 path=${p} 的菜单`)
  return hit
}

async function detail(api: ApiClient, id: string): Promise<Record<string, unknown>> {
  const d = (await api.get(`/api/v1/sys/menus/${id}`)) as MenuDetail
  return Object.fromEntries(WRITABLE.map((k) => [k, d[k] ?? null]))
}

test.describe("菜单：改了就要看得到", () => {
  test("🔴 改内置菜单的标题：中文界面处处是新名字（含已经开着的标签），英文界面仍是内置译名", async ({
    authedPage: page,
    api,
  }) => {
    const menu = await findByPath(api, "/system/dept")
    const original = await detail(api, menu.id)
    const renamed = `部门架构${uniqueCode("R").slice(-4)}`
    const sidebar = page.locator('[data-sidebar="sidebar"]')

    // 先开成一个标签：它存下的标题是打开那一刻的
    await page.goto("/system/dept")
    await expect(page.getByTestId("tab-bar")).toContainText(String(original.title))
    try {
      await api.put(`/api/v1/sys/menus/${menu.id}`, { ...original, title: renamed })
      await page.reload()
      await expect(sidebar).toContainText(renamed)
      await expect(page.getByTestId("tab-bar")).toContainText(renamed)
      await expect(page.getByRole("navigation", { name: "breadcrumb" })).toContainText(renamed)
      await page.goto("/system/menu")
      await expect(page.getByTestId("menu-table")).toContainText(renamed)

      // 英文界面：内置菜单显示的还是按路由地址预置的译名
      await page.evaluate(() => localStorage.setItem("admin:language", "en-US"))
      await page.goto("/system/dept")
      await expect(sidebar).toContainText(EN["menu:/system/dept"])
      await expect(sidebar).not.toContainText(renamed)
    } finally {
      await api.put(`/api/v1/sys/menus/${menu.id}`, original)
    }
  })

  test("🔴 停用一个目录：它和下面的页面一起从侧边栏消失，重新启用就回来", async ({ authedPage: page, api }) => {
    const dir = await findByPath(api, "/log")
    const original = await detail(api, dir.id)
    const child = dir.children?.find((c) => c.path === "/log/login")
    if (!child) throw new Error("前置：/log 下面要有 /log/login")
    const other = await findByPath(api, "/system")
    const sidebar = page.locator('[data-sidebar="sidebar"]')

    await page.goto("/dashboard")
    await expect(sidebar.getByTestId(`nav-group-${dir.title}`)).toBeVisible()
    try {
      await api.put(`/api/v1/sys/menus/${dir.id}`, { ...original, status: 0 })
      await page.reload()
      // 先断言「有」：侧边栏已经渲染出来了，下面的「没有」才不是骨架屏阶段的假绿
      await expect(sidebar.getByTestId(`nav-group-${other.title}`)).toBeVisible()
      await expect(sidebar.getByTestId(`nav-group-${dir.title}`)).toHaveCount(0)
      await expect(sidebar).not.toContainText(child.title)
    } finally {
      await api.put(`/api/v1/sys/menus/${dir.id}`, original)
    }
    await page.reload()
    await expect(sidebar.getByTestId(`nav-group-${dir.title}`)).toBeVisible()
  })
})
