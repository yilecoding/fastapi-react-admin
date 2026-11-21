import { expect, test } from "../fixtures/base"

/**
 * #405：隐藏页签里迟到的 `onSearchChange` 不能把人拽回去。
 *
 * 不少页面是「await 完请求再写 URL」（审批的同意 / 退回、角色 / 字典删掉选中项后清掉 URL 里的选中）。
 * 点完立刻切去别的页，请求回来时那一页已经在后台 —— 原来 `TabFrame.onSearchChange` 不看自己在不在前台，
 * 照样 `navigate({ to: 本页, replace: true })`：用户被拽回去，刚切过去的那条历史还被覆盖掉了。
 *
 * 这里用字典页「删掉当前选中的类型 → 清掉 URL 里的 `type`」那一处：删除请求用 `page.route` 拖住，
 * 拖住的那段时间里关掉弹窗、切到工作台，再放行。
 */
test("后台页签的请求回来后改 search：不抢地址栏，切回去时 URL 跟上", async ({ authedPage: page, api }) => {
  const run = Date.now().toString(36)
  const code = `e2ehts_${run}`
  await api.post("/api/v1/sys/dict-types", { name: `E2E后台页签${run}`, code })
  const types = (await api.get(`/api/v1/sys/dict-types?code=${code}`)) as { items: Array<{ id: string }> }
  const typeId = types.items[0].id
  try {
    await page.goto("/dashboard")
    await expect(page.getByTestId("tab-/_auth/dashboard")).toBeVisible()
    await page.goto(`/plugins/dict?type=${typeId}`)
    const dict = page.locator('[data-tab="/_auth/plugins/dict"]')
    await expect(dict.getByTestId("selected-type")).toContainText(`E2E后台页签${run}`)

    // 拖住删除请求，直到切走之后再放行
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    let deleteSeen!: () => void
    const deleting = new Promise<void>((resolve) => (deleteSeen = resolve))
    await page.route(/\/api\/v1\/sys\/dict-types$/, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback()
      deleteSeen()
      await held
      await route.fallback()
    })

    await dict.getByTestId(`type-actions-${typeId}`).click()
    await page.getByRole("menuitem", { name: "删除" }).click()
    await page.getByTestId("confirm-ok").click()
    await deleting
    // 请求还在路上：关掉弹窗，切到工作台
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("confirm-dialog")).toBeHidden()
    await page.getByTestId("tab-/_auth/dashboard").click()
    await expect(page).toHaveURL(/\/dashboard$/)

    const deleted = page.waitForResponse((r) => r.request().method() === "DELETE" && /\/sys\/dict-types$/.test(r.url()))
    release()
    expect((await deleted).status()).toBe(200)

    // 🔴 修之前：这里被拽回 /plugins/dict
    await expect(page.locator('[data-tab="/_auth/dashboard"]')).toHaveAttribute("data-visible", "true")
    await page.waitForTimeout(500)
    await expect(page).toHaveURL(/\/dashboard$/)
    await expect(page.locator('[data-tab="/_auth/dashboard"]')).toHaveAttribute("data-visible", "true")

    // 切回去：地址按后台写下的新 search 走，删掉的那个类型不在 URL 里了
    await page.getByTestId("tab-/_auth/plugins/dict").click()
    await expect(page).toHaveURL(/\/plugins\/dict/)
    expect(new URL(page.url()).searchParams.get("type")).toBeNull()
    await expect(dict).toHaveAttribute("data-visible", "true")
  } finally {
    await api.del("/api/v1/sys/dict-types", { pks: [typeId] }).catch(() => undefined)
  }
})

/**
 * #405：每个页签一道错误边界。原来任一页（含后台的）抛渲染异常，整屏换成路由的 500，别的页签一起没了；
 * 页签列表在 sessionStorage 里，刷新后出错的那页原样恢复、再炸一次 —— 这个浏览器标签页里出不来。
 *
 * 造一个渲染异常：「最近登录」拿到一个不是数组、却有 `length` 的值，`data.map` 抛 TypeError。
 */
test("一页渲染抛错只换掉那一页：标签条和别的页签都在，重新加载能恢复", async ({ authedPage: page }) => {
  const broken = /\/api\/v1\/sys\/users\/me\/login-logs/
  await page.route(broken, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 200, msg: "ok", data: { length: 1 } }) })
  )
  await page.goto("/system/dept")
  await expect(page.getByTestId("tab-/_auth/system/dept")).toBeVisible()
  await page.goto("/profile?section=security")

  const profile = page.locator('[data-tab="/_auth/profile"]')
  await expect(profile.getByTestId("tab-crash")).toBeVisible()
  // 🔴 修之前：整屏是「出错了 / 500」，标签条也没了
  await expect(page.getByTestId("tab-/_auth/system/dept")).toBeVisible()
  await expect(page.getByText("页面渲染时发生未预期的错误。")).toHaveCount(0)

  await page.getByTestId("tab-/_auth/system/dept").click()
  await expect(page.locator('[data-tab="/_auth/system/dept"]')).toHaveAttribute("data-visible", "true")
  await expect(page.locator('[data-tab="/_auth/system/dept"] [data-testid="dept-table"]')).toBeVisible()

  // 接口恢复后，回到出错的那页点「重试」（= 重新加载此页）就好了
  await page.unroute(broken)
  await page.getByTestId("tab-/_auth/profile").click()
  await profile.getByTestId("tab-crash-error-retry").click()
  await expect(profile.getByTestId("tab-crash")).toHaveCount(0)
  await expect(profile.getByTestId("p-logins").or(profile.getByTestId("p-logins-empty"))).toBeVisible()
})
