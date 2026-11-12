import { expect, loginPageAs, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

test("用户末页批量删除后回到第一页并清掉选中", async ({ authedPage: page, api }) => {
  const prefix = uniqueCode("E2EPUSER").toLowerCase()
  const staff = await api.get("/api/v1/sys/users?username=zhaolei&page=1&size=20") as {
    items: { username: string; dept: { id: string }; roles: { id: string }[] }[]
  }
  const template = staff.items.find(u => u.username === "zhaolei")!
  try {
    for (let i = 0; i < 3; i++) {
      const username = prefix + i
      await api.post("/api/v1/sys/users", {
        username, nickname: username, password: "E2E!123456", email: username + '@e2e.example.com',
        dept_id: template.dept.id, roles: template.roles.map(r => r.id),
      })
    }
    await page.goto('/system/user?username=' + prefix + '&page=2&size=2')
    const tab = page.locator('[data-tab="/_auth/system/user"]')
    const table = tab.getByTestId("user-table")
    const rows = table.locator('[data-slot="table-body"] [data-slot="table-row"]')
    await expect(rows).toHaveCount(1)
    await rows.getByRole("checkbox").click()
    await tab.getByTestId("bulk-delete").click()
    await page.getByTestId("confirm-ok").click()
    await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false)
    await expect(rows).toHaveCount(2)
    await expect(tab.getByTestId("bulk-count")).toBeHidden()
    expect(new URL(page.url()).searchParams.get("username")).toBe(prefix)
    await page.reload()
    await expect(rows).toHaveCount(2)
  } finally {
    const left = await api.get('/api/v1/sys/users?username=' + prefix + '&page=1&size=200') as { items: { id: string }[] }
    for (const user of left.items) await api.del('/api/v1/sys/users/' + user.id)
  }
})

test("删除末页最后一行后回到新的末页，筛选保留，删空后回到第一页", async ({ authedPage: page, api }) => {
  const prefix = uniqueCode("E2EPAGE")
  try {
    for (let i = 0; i < 3; i++) {
      const code = prefix + i
      await api.post("/api/v1/open-apps", { code, name: code, scopes: ["user:read"] })
    }
    await page.goto('/open/app?name=' + prefix + '&page=3&size=1')
    const tab = page.locator('[data-tab="/_auth/open/app"]')
    for (let remaining = 3; remaining > 0; remaining--) {
      const action = tab.locator('[data-testid^="row-actions-"]').first()
      await expect(action).toBeVisible()
      const code = (await action.getAttribute("data-testid"))!.slice("row-actions-".length)
      await action.click()
      await page.getByTestId('delete-' + code).click()
      await page.getByTestId("confirm-ok").click()
      const target = Math.max(1, remaining - 1)
      await expect.poll(() => Number(new URL(page.url()).searchParams.get("page") ?? 1)).toBe(target)
      expect(new URL(page.url()).searchParams.get("name")).toBe(prefix)
      expect(new URL(page.url()).searchParams.get("size")).toBe("1")
      await expect(tab.locator('[data-slot="pagination"]')).toContainText('第 ' + target + ' / ' + target + ' 页')
      await expect(tab.locator('[data-testid^="row-actions-"]')).toHaveCount(remaining > 1 ? 1 : 0)
    }
    await page.reload()
    await expect(tab.locator('[data-slot="pagination"]')).toContainText("第 1 / 1 页")
    expect(new URL(page.url()).searchParams.has("page")).toBe(false)
  } finally {
    const left = await api.get('/api/v1/open-apps?name=' + prefix + '&page=1&size=200') as { items: { id: string }[] }
    for (const app of left.items) await api.del('/api/v1/open-apps/' + app.id)
  }
})

test("审批末页办完回到第一页，待办仍可见，详情参数正常关闭", async ({ page, api }) => {
  test.slow()
  const code = uniqueCode("E2EWPAGE")
  const users = await api.get("/api/v1/sys/users?username=zhaolei&page=1&size=20") as { items: { id: string; username: string }[] }
  const approverId = users.items.find(u => u.username === "zhaolei")!.id
  const definition = await api.post("/api/v1/sys/workflow/definitions", {
    code, name: code,
    form: { schemaVersion: 1, fields: [{ id: "reason", type: "text", label: "事由" }] },
    model: { schemaVersion: 1, root: { type: "start", id: "start", next: {
      type: "approval", id: "approve", name: "审批", mode: "any",
      assignee: { kind: "user", user_ids: [approverId] }, onEmpty: "reject", next: null,
    } } },
  }) as { id: string }
  const ids: string[] = []
  let holdCounts = false
  let releaseCounts: (() => void) | undefined
  const countsGate = new Promise<void>(resolve => { releaseCounts = resolve })
  await page.route('**/api/v1/sys/workflow/inbox/counts', async route => {
    if (holdCounts) await countsGate
    await route.fallback()
  })
  try {
    await api.post('/api/v1/sys/workflow/definitions/' + definition.id + '/publish')
    for (let i = 0; i < 2; i++) {
      const started = await api.post("/api/v1/sys/workflow/instances", {
        code, form: { reason: code + '-' + i }, key: code + '-' + i,
      }) as { instance_id: string }
      ids.push(started.instance_id)
    }
    await loginPageAs(page, "zhaolei", "123456")
    await page.goto('/workflow/inbox?keyword=' + code + '&page=2&size=1')
    const tab = page.locator('[data-tab="/_auth/workflow/inbox"]')
    await tab.locator('[data-testid^="wf-row-"]').click()
    const sheet = page.getByTestId("wf-instance-sheet")
    // 列表先重取完、其他失效查询仍在路上：人为拉开「回页」与「关闭详情」的窗口。
    holdCounts = true
    await sheet.getByTestId("wf-act-approve").click()
    await expect(tab.getByTestId("wf-inbox-empty")).toBeAttached()
    await expect(tab.getByTestId("list-refresh")).toHaveAttribute("aria-busy", "false")
    expect(new URL(page.url()).searchParams.get("page")).toBe("2")
    releaseCounts?.()
    await expect(sheet).toBeHidden()
    await expect.poll(() => Number(new URL(page.url()).searchParams.get("page") ?? 1)).toBe(1)
    await expect(tab.locator('[data-testid^="wf-row-"]')).toHaveCount(1)
    await expect(tab.getByTestId("wf-inbox-empty")).toHaveCount(0)
    expect(new URL(page.url()).searchParams.get("keyword")).toBe(code)
    expect(new URL(page.url()).searchParams.has("id")).toBe(false)
    await page.reload()
    await expect(tab.locator('[data-testid^="wf-row-"]')).toHaveCount(1)
  } finally {
    releaseCounts?.()
    for (const id of ids) {
      const detail = await api.get('/api/v1/sys/workflow/instances/' + id) as { instance: { status: string } }
      if (detail.instance.status === "running") await api.post('/api/v1/sys/workflow/instances/' + id + '/actions', { action: "withdraw", key: code + '-cleanup-' + id, opinion: "E2E 清理" })
    }
    await api.put('/api/v1/sys/workflow/definitions/' + definition.id + '/status', { enabled: false })
  }
})

test("过期深链回到有效末页，列设置保留，空结果回到第一页", async ({ authedPage: page, api }) => {
  const prefix = uniqueCode("E2EPLINK")
  try {
    for (let i = 0; i < 2; i++) {
      const code = prefix + i
      await api.post("/api/v1/open-apps", { code, name: code, scopes: ["user:read"] })
    }
    await page.goto('/open/app?name=' + prefix + '&page=9999&size=1&hide=access_key&cols=state,name')
    const tab = page.locator('[data-tab="/_auth/open/app"]')
    await expect(tab.locator('[data-testid^="row-actions-"]')).toHaveCount(1)
    await expect.poll(() => new URL(page.url()).searchParams.get("page")).toBe("2")
    expect(new URL(page.url()).searchParams.get("hide")).toBe("access_key")
    expect(new URL(page.url()).searchParams.get("cols")).toBe("state,name")
    await page.reload()
    await expect(tab.locator('[data-slot="pagination"]')).toContainText("第 2 / 2 页")

    await page.goto('/open/app?name=' + prefix + '-missing&page=9999&size=1')
    await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false)
    await expect(tab.locator('[data-slot="pagination"]')).toContainText("第 1 / 1 页")
    expect(new URL(page.url()).searchParams.get("name")).toBe(prefix + '-missing')
    await expect(tab.locator('[data-testid^="row-actions-"]')).toHaveCount(0)
  } finally {
    const left = await api.get('/api/v1/open-apps?name=' + prefix + '&page=1&size=200') as { items: { id: string }[] }
    for (const app of left.items) await api.del('/api/v1/open-apps/' + app.id)
  }
})

test("越界页请求失败保留页码，重试成功后才回退", async ({ authedPage: page }) => {
  let fail = true
  await page.route(/\/api\/v1\/open-apps\?/, async route => {
    if (!fail) return route.fallback()
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ code: 502, msg: "分页回退 E2E：网关失败", data: null }),
    })
  })
  const name = uniqueCode("E2EPMISSING")
  await page.goto('/open/app?name=' + name + '&page=9999&size=1')
  const tab = page.locator('[data-tab="/_auth/open/app"]')
  const error = tab.getByTestId("query-error")
  await expect(error).toBeVisible()
  expect(new URL(page.url()).searchParams.get("page")).toBe("9999")
  fail = false
  await error.getByTestId("query-error-retry").click()
  await expect.poll(() => new URL(page.url()).searchParams.has("page")).toBe(false)
  await expect(error).toBeHidden()
  expect(new URL(page.url()).searchParams.get("name")).toBe(name)
})

test("换筛选后的慢响应不能用上次的空结果把有效末页拉回第一页", async ({ authedPage: page, api }) => {
  const prefix = uniqueCode("E2EPSLOW")
  let release: (() => void) | undefined
  const pending = new Promise<void>(resolve => { release = resolve })
  let intercepted: (() => void) | undefined
  const started = new Promise<void>(resolve => { intercepted = resolve })
  try {
    for (let i = 0; i < 3; i++) {
      const code = prefix + i
      await api.post("/api/v1/open-apps", { code, name: code, scopes: ["user:read"] })
    }
    // 先留下一组空结果，再在同一个页面内换查询，真正触发 placeholderData。
    await page.goto('/open/app?name=' + prefix + '-missing&size=1')
    const tab = page.locator('[data-tab="/_auth/open/app"]')
    await expect(tab).toContainText("没有匹配的应用")
    await expect(tab.locator('[data-slot="pagination"]')).toContainText("第 1 / 1 页")

    await page.route(/\/api\/v1\/open-apps\?/, async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get("name") !== prefix || url.searchParams.get("page") !== "3") return route.fallback()
      intercepted?.()
      await pending
      await route.fallback()
    })
    // E2E 的 Node tsconfig 不带 DOM lib；字符串只在浏览器上下文求值。
    const href = '/open/app?name=' + prefix + '&page=3&size=1'
    await page.evaluate('history.pushState({}, "", ' + JSON.stringify(href) + '); dispatchEvent(new PopStateEvent("popstate"))')
    await started
    // 等 UI 消化历史导航：新页正在请求，表体仍是上一组筛选的空占位。
    await expect(tab.locator('[aria-busy="true"]').first()).toBeVisible()
    expect(new URL(page.url()).searchParams.get("page")).toBe("3")
    release?.()
    await expect(tab.locator('[data-testid^="row-actions-"]')).toHaveCount(1)
    await expect(tab.locator('[data-slot="pagination"]')).toContainText("第 3 / 3 页")
    expect(new URL(page.url()).searchParams.get("page")).toBe("3")
  } finally {
    release?.()
    const left = await api.get('/api/v1/open-apps?name=' + prefix + '&page=1&size=200') as { items: { id: string }[] }
    for (const app of left.items) await api.del('/api/v1/open-apps/' + app.id)
  }
})
