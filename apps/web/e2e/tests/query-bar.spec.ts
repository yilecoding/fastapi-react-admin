import { expect, test } from "../fixtures/base"

/**
 * 查询区（`ui/components/query-bar/`）+ 视图状态进 URL。
 *
 * 这一条覆盖的是**共用模板**，不是某一页：20 个列表页共用同一个 `QueryBar` +
 * `_shared/use-query-search`，所以测一次这里等于替所有列表页守住同一批行为
 * ——这也是 e2e/AGENTS.md「测一次模板 + 抽样几页就够」那句话的落点。
 * 挑登录日志页只是因为它的四个字段把三种类型都占了（text / select / dateTimeRange）。
 *
 * 守的是根 CLAUDE.md 硬纪律 2：**视图状态必须进 URL**。
 * `<Activity>` 保活只在会话内有效，刷新就全丢；search params 才是跨刷新的持久层。
 * 这三条断言全都以「reload 之后还在不在」结尾 —— 不 reload 的话，
 * 保活机制会把「其实没写进 URL」这件事完全盖住。
 *
 * 另外两条顺带守住的契约（都写在 query-bar/AGENTS.md 里）：
 * - 地址栏里的字符串值**不加引号**（`?username=admin` 而不是 `?username="admin"`）
 * - 重置要把查询区管的键**从 URL 里清掉**，不能只清界面 —— 留在地址栏的话，
 *   界面上没有那一格、请求里也没有它，但复制出去的链接还带着一个隐形筛选
 */

const LOGIN_LOG = "/log/login"

test.describe("查询区 · 视图状态进 URL", () => {
  test("🔴 填了条件点搜索 → 写进地址栏（裸值不带引号）→ 刷新后还在", async ({
    authedPage: page,
  }) => {
    await page.goto(LOGIN_LOG)
    await expect(page.getByTestId("query-bar")).toBeVisible()

    await page.getByTestId("qb-input-username").fill("admin")
    await page.getByTestId("qb-search").click()

    // 裸值：TanStack 默认会把字符串 JSON.stringify 成 `"admin"`，
    // `lib/search-params.ts` 的 stringifyValue 专门把这层引号去掉了
    await expect(page).toHaveURL(/[?&]username=admin(&|$)/)

    await page.reload()
    // 刷新之后条件要从 URL 恢复到界面上 —— 这一格必须还填着 admin
    await expect(page.getByTestId("qb-input-username")).toHaveValue("admin")
  })

  test("🔴 删掉一个默认格子，刷新后它不会自己回来（`f` 要记住「减」的方向）", async ({
    authedPage: page,
  }) => {
    await page.goto(LOGIN_LOG)
    await expect(page.getByTestId("qb-cond-ip")).toBeVisible()

    await page.getByTestId("qb-remove-ip").click()
    await page.getByTestId("qb-search").click()

    await expect(page.getByTestId("qb-cond-ip")).toBeHidden()
    // `f` 记的是**最终布局**（不是增量），所以它出现了、且不含被删掉的 ip
    const url = new URL(page.url())
    const layout = url.searchParams.get("f")
    expect(layout, "删掉默认格子之后 f 必须出现，否则刷新时无从表达「我删过它」").not.toBeNull()
    expect(layout?.split(",")).not.toContain("ip")

    await page.reload()
    // 只记「摆开的格子」而不记「删掉的」，这里 ip 会自己长回来
    await expect(page.getByTestId("qb-cond-ip")).toBeHidden()
    await expect(page.getByTestId("qb-cond-username")).toBeVisible()
  })

  test("重置要把查询区管的键从地址栏一起清掉，不能只清界面", async ({ authedPage: page }) => {
    // 直接带着条件进来 —— 等价于「别人发了一个带筛选的链接」
    await page.goto(`${LOGIN_LOG}?username=admin`)
    await expect(page.getByTestId("qb-input-username")).toHaveValue("admin")

    await page.getByTestId("qb-reset").click()

    await expect(page.getByTestId("qb-input-username")).toHaveValue("")
    // 界面清了不算数：留在地址栏里的话，复制出去的链接还带着一个看不见的筛选
    await expect(page).not.toHaveURL(/[?&]username=/)
  })
})
