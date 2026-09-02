import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 菜单死链判定（`pages/menu/dead-link.ts`）。
 *
 * 「这条菜单的 path 在前端路由里不存在」是一种**静默故障**：菜单在库里、
 * 权限也发下去了，但 `shell/use-sidebar.ts: toNavTree` 会把它跳过 ——
 * 侧边栏上什么都不显示，没有任何报错，配的人以为自己配好了。
 * 菜单页那个「N 个死链」的角标是唯一替人看见它的地方，所以它本身必须有测试。
 *
 * 两个方向都要守，而且**假阳性和假阴性一样有害**：
 *
 * - 漏报：真死链不被标出来 → 回到上面那个静默故障
 * - 误报：正常工作的目录被划删除线 → 人会去「修」一个没坏的东西。
 *   这不是假想：`dead-link.ts` 的注释记着，原实现把目录和菜单一视同仁，
 *   于是 `/system` `/log` `/monitor` 三个工作得好好的目录被判成死链，
 *   59 项里的「8 个死链」有 3 个是假的。第二条测试就是那次的回归。
 */

type Menu = { id: string; name: string; title: string; path: string | null; children?: Menu[] }

const MENU_TYPE = { DIR: 0, MENU: 1, BUTTON: 2 } as const

function flatten(tree: Menu[]): Menu[] {
  return tree.flatMap((m) => [m, ...flatten(m.children ?? [])])
}

test.describe("菜单死链", () => {
  const created: string[] = []

  test.afterEach(async ({ api }) => {
    // 一条条删：菜单没有批量删除接口，而且留在库里会让侧边栏多出一项
    for (const id of created) await api.del(`/api/v1/sys/menus/${id}`).catch(() => {})
    created.length = 0
  })

  test("🔴 path 指向不存在的前端路由 → 计上死链，且「只看死链」筛得到它", async ({
    authedPage: page,
    api,
  }) => {
    const name = `E2EDead${uniqueCode("M").slice(-6)}`

    await page.goto("/system/menu")
    await expect(page.getByTestId("menu-table")).toBeVisible()
    // ⚠️ 不能用 `innerText().catch()` 取「之前的值」：角标在没有死链时压根**不渲染**，
    // 而 `innerText()` 会为一个不存在的元素死等满 30 秒超时 —— 表现成整条测试超时，
    // 报错还指向后面那句无辜的 api.post。先 `count()` 探一下，它不等待。
    const badge = page.getByTestId("broken-count")
    const before = (await badge.count()) > 0 ? await badge.innerText() : null

    // 造一条**菜单**（不是目录）指向一个前端肯定没有的路由
    await api.post("/api/v1/sys/menus", {
      title: name,
      name,
      path: `/definitely-not-a-route/${name.toLowerCase()}`,
      parent_id: null,
      sort: 999,
      icon: null,
      type: MENU_TYPE.MENU,
      perms: null,
      status: 1,
      display: 1,
      link: null,
      remark: "E2E 死链判定用，跑完会删",
    })
    const tree = (await api.get("/api/v1/sys/menus")) as Menu[]
    const mine = flatten(tree).find((m) => m.name === name)
    if (!mine) throw new Error(`菜单建完却找不到：${name}`)
    created.push(mine.id)

    await page.reload()

    // 行上要有死链标记
    await expect(page.getByTestId(`menu-dead-${name}`)).toBeVisible()
    // 角标要出现；本来就有的话，数字必须变了
    // （不断言具体数字 —— 种子里有几个是会变的，别的 spec 也可能并行）
    await expect(badge).toBeVisible()
    if (before !== null) await expect(badge).not.toHaveText(before)

    // 点角标 = 只看死链。筛完之后我这条还在，说明它确实被算进去了
    await page.getByTestId("broken-count").click()
    await expect(page).toHaveURL(/[?&]broken=true/)
    await expect(page.getByTestId(`menu-row-${name}`)).toBeVisible()
  })

  test("🔴 目录有可见子项时不算死链（那 3 个假死链的回归）", async ({ authedPage: page, api }) => {
    const tree = (await api.get("/api/v1/sys/menus")) as Menu[]

    // 种子里的目录：自己的 path 前端**确实没有**对应路由，但它有子项，
    // 侧边栏把它当可展开分组，path 根本不会被用到 —— 这是设计如此，不是坏了
    const dirs = tree.filter(
      (m) => (m as Menu & { type: number }).type === MENU_TYPE.DIR && (m.children?.length ?? 0) > 0
    )
    expect(dirs.length, "种子里应该有带子项的目录，否则这条回归无从谈起").toBeGreaterThan(0)

    await page.goto("/system/menu")
    await expect(page.getByTestId("menu-table")).toBeVisible()

    for (const dir of dirs) {
      await expect(
        page.getByTestId(`menu-dead-${dir.name}`),
        `目录 ${dir.name}（${dir.path}）有子项，不该被标成死链`
      ).toBeHidden()
    }
  })

  test("按钮不进侧边栏，所以没有 path 也不算死链", async ({ authedPage: page, api }) => {
    const name = `E2EBtn${uniqueCode("M").slice(-6)}`
    const tree = (await api.get("/api/v1/sys/menus")) as Menu[]
    const parent = tree.find((m) => (m.children?.length ?? 0) > 0)
    if (!parent) throw new Error("找不到可以挂按钮的父菜单")

    await api.post("/api/v1/sys/menus", {
      title: name,
      name,
      path: null,
      parent_id: parent.id,
      sort: 999,
      icon: null,
      type: MENU_TYPE.BUTTON,
      perms: "e2e:dead:test",
      status: 1,
      display: 0,
      link: null,
      remark: "E2E 死链判定用，跑完会删",
    })
    const mine = flatten((await api.get("/api/v1/sys/menus")) as Menu[]).find((m) => m.name === name)
    if (!mine) throw new Error(`按钮建完却找不到：${name}`)
    created.push(mine.id)

    await page.goto("/system/menu")
    await expect(page.getByTestId("menu-table")).toBeVisible()

    // 按钮只提供 perms 权限标识，本来就不进侧边栏 —— 把它算成死链会让
    // 计数里混进一大批噪音，人就不看那个角标了
    await expect(page.getByTestId(`menu-dead-${name}`)).toBeHidden()
  })
})
