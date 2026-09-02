import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 功能权限矩阵（角色页 `tab=perms`）。
 *
 * `data-permission.spec.ts` 覆盖的是同一页的 `scopes` / 规则那一侧，**权限矩阵本身
 * 一条测试都没有** —— 而根 CLAUDE.md 硬纪律 6 里记的那个真 bug 就发生在这里：
 * `?role=2202097973238829056` 被 TanStack Router 默认的 `JSON.parse` 变成
 * `2202097973238829000`，详情面板显示的是**列表第一个角色**，于是「保存权限」
 * 把勾选写到了另一条记录上。挡住它的是 `apps/web/src/lib/search-params.ts`，
 * 而那份守卫此前只有单元层面的注释，没有端到端的回归。
 *
 * 所以第一条测试的断言不是「能保存」，是「**保存到了正确的那个角色**」：
 * 建两个角色，只动其中一个，另一个必须原封不动。这条断言在解析被改坏时必然红，
 * 在功能正常时永远绿 —— 与角色 ID 具体是多少无关。
 */

type MenuNode = { id: string; title: string; children?: MenuNode[] | null }

/** 建一个空权限的角色，返回 id。清理交给 afterEach。 */
async function createRole(
  api: { post: (p: string, d?: unknown) => Promise<unknown>; get: (p: string) => Promise<unknown> },
  name: string
): Promise<string> {
  await api.post("/api/v1/sys/roles", {
    code: uniqueCode("E2EPM"),
    name,
    status: 1,
    is_filter_scopes: true,
    remark: null,
  })
  const all = (await api.get("/api/v1/sys/roles/all")) as Array<{ id: string; name: string }>
  const role = all.find((r) => r.name === name)
  if (!role) throw new Error(`角色建完却找不到：${name}`)
  return role.id
}

/** 菜单树里第一个「有子节点」的目录，用来测节点关联 / 孤儿告警 */
function firstDirWithKid(tree: MenuNode[]): { dir: MenuNode; kid: MenuNode } {
  for (const node of tree) {
    const kid = node.children?.[0]
    if (kid) return { dir: node, kid }
  }
  throw new Error("菜单树里没有任何带子节点的目录，测试前置不成立")
}

test.describe("功能权限矩阵", () => {
  // 🔴 唯一约束在角色名/编码上，两条测试并行建同名角色会撞。
  // 每条测试自己带随机后缀，所以这里不用 serial —— 但清理必须在 afterEach 做，
  // 否则 `fba_test` 里会越攒越多角色，把别的 spec 的默认分页假设挤坏
  //（`list-error.spec.ts` 踩过那个坑，见 e2e/AGENTS.md）。
  const created: string[] = []

  test.afterEach(async ({ api }) => {
    if (created.length > 0) await api.del("/api/v1/sys/roles", { pks: [...created] }).catch(() => {})
    created.length = 0
  })

  test("🔴 保存权限只写到地址栏点名的那个角色上（雪花 ID 的端到端回归）", async ({
    authedPage: page,
    api,
  }) => {
    const sfx = uniqueCode("X").slice(-8)
    const untouchedId = await createRole(api, `PM-${sfx}-A`)
    const targetId = await createRole(api, `PM-${sfx}-B`)
    created.push(untouchedId, targetId)

    const tree = (await api.get("/api/v1/sys/menus")) as MenuNode[]
    const { dir } = firstDirWithKid(tree)

    await page.goto(`/system/role?role=${targetId}&tab=perms`)

    // 先证明路由层没把 ID 改坏 —— 后面所有断言都建立在「面板里是 B」之上
    await expect(page.getByTestId("role-detail-name")).toHaveText(`PM-${sfx}-B`)
    await expect(page.getByTestId("perm-matrix")).toBeVisible()

    // 勾一个目录（默认「节点关联」，会连着把子节点一起勾上）
    await page.getByTestId(`perm-check-${dir.id}`).click()
    await expect(page.getByTestId("perm-dirty")).toBeVisible()

    await page.getByTestId("perm-save").click()
    // 存完 draft 清空，「未保存」徽章跟着消失 —— 这就是保存成功的界面信号
    await expect(page.getByTestId("perm-dirty")).toBeHidden()

    const savedOnTarget = (await api.get(`/api/v1/sys/roles/${targetId}/menus`)) as MenuNode[] | null
    expect(savedOnTarget?.length ?? 0).toBeGreaterThan(0)

    // 🔴 这一条才是回归点：ID 被解析坏时，写入会落到列表里的另一个角色上
    const savedOnUntouched = (await api.get(`/api/v1/sys/roles/${untouchedId}/menus`)) as
      | MenuNode[]
      | null
    expect(savedOnUntouched?.length ?? 0).toBe(0)
  })

  test("「还原」把没保存的改动丢掉，计数回到服务端那一份", async ({ authedPage: page, api }) => {
    const sfx = uniqueCode("X").slice(-8)
    const roleId = await createRole(api, `PM-${sfx}-R`)
    created.push(roleId)

    const tree = (await api.get("/api/v1/sys/menus")) as MenuNode[]
    const { dir } = firstDirWithKid(tree)

    await page.goto(`/system/role?role=${roleId}&tab=perms`)
    await expect(page.getByTestId("perm-matrix")).toBeVisible()

    // ⚠️ 读 `perm-count` 之前必须先等**树真的加载完**：`perm-matrix` 这个容器在
    // 骨架屏阶段就在了，那时计数是「已选 0 / 0」（总数来自还没回来的菜单树）。
    // 拿这个中间态当基准，还原之后比对的是「0 / 0」vs「0 / 79」——
    // 隔离跑很少撞上，整套跑（机器忙）就会红。等一个具体的行即可。
    await expect(page.getByTestId(`perm-check-${dir.id}`)).toBeVisible()
    const before = await page.getByTestId("perm-count").innerText()

    await page.getByTestId(`perm-check-${dir.id}`).click()
    await expect(page.getByTestId("perm-dirty")).toBeVisible()
    // 勾完计数必须真的变了，否则下面「还原回去」等于没验
    await expect(page.getByTestId("perm-count")).not.toHaveText(before)

    await page.getByTestId("perm-reset").click()
    await expect(page.getByTestId("perm-dirty")).toBeHidden()
    await expect(page.getByTestId("perm-count")).toHaveText(before)

    // 还原只动本地 draft，不该往服务端写
    const saved = (await api.get(`/api/v1/sys/roles/${roleId}/menus`)) as MenuNode[] | null
    expect(saved?.length ?? 0).toBe(0)
  })

  test("🔴 节点独立模式下只勾子节点会给孤儿告警，点一下自动补齐父节点", async ({
    authedPage: page,
    api,
  }) => {
    const sfx = uniqueCode("X").slice(-8)
    const roleId = await createRole(api, `PM-${sfx}-O`)
    created.push(roleId)

    const tree = (await api.get("/api/v1/sys/menus")) as MenuNode[]
    const { kid } = firstDirWithKid(tree)

    await page.goto(`/system/role?role=${roleId}&tab=perms`)
    await expect(page.getByTestId("perm-matrix")).toBeVisible()

    // 「节点独立」= 勾子节点不带上父节点。这正是能造出孤儿的模式：
    // 授权了子菜单、没授权它的父目录 —— 侧边栏里那一项**永远显示不出来**，
    // 而权限本身是给了的。界面上这条告警是唯一能替人看见它的地方。
    await page.getByTestId("perm-free").click()
    await page.getByTestId(`perm-check-${kid.id}`).click()

    await expect(page.getByTestId("perm-orphans")).toBeVisible()

    // 点告警本身 = 自动把缺的父节点补上
    await page.getByTestId("perm-orphans").click()
    await expect(page.getByTestId("perm-orphans")).toBeHidden()
  })
})
