import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

// 浏览器 +09，个人显示时区 -03：刻意不相同，防止本地时区碰巧掩盖 #332。
test.use({ timezoneId: "Asia/Tokyo" })

test.beforeEach(async ({ authedPage: page }) => {
  // 只替换本页面的个人偏好；应用的创建、查询、编辑和删除仍走真实接口。
  await page.route("**/api/v1/sys/users/me", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({ response, json: { ...body, data: { ...body.data, timezone: "America/Sao_Paulo" } } })
  })
})

test("新建失效时间按显示时区保存，列表和重新编辑保持同一钟点", async ({ authedPage: page, api }) => {
  const code = uniqueCode("E2E_TZ")
  let id: string | undefined
  try {
    await page.goto(`/open/app?name=${code}`)
    const tab = page.locator('[data-tab="/_auth/open/app"]')
    await tab.getByTestId("open-app-add").click()
    await page.getByTestId("open-app-code").fill(code)
    await page.getByTestId("open-app-name").fill(code)
    await page.getByTestId("open-scope-user:read").click()
    const expiry = page.getByRole("textbox", { name: "失效时间", exact: true })
    await expiry.fill("2028-07-15 18:30:45")
    await expiry.press("Enter")
    const created = page.waitForResponse((r) => r.url().endsWith("/api/v1/open-apps") && r.request().method() === "POST")
    await page.getByTestId("open-app-submit").click()
    const response = await created
    const body = await response.json()
    expect(response.ok()).toBeTruthy()
    id = body.data.id
    await page.getByTestId("open-secret-saved").click()

    const saved = (await api.get(`/api/v1/open-apps/${id}`)) as { expire_time: string }
    expect(new Date(saved.expire_time).toISOString()).toBe("2028-07-15T21:30:45.000Z")
    const row = tab.getByRole("row").filter({ hasText: code })
    await expect(row).toContainText("2028-07-15 18:30:45")
    await tab.getByTestId(`row-actions-${code}`).click()
    await page.getByTestId(`edit-${code}`).click()
    await expect(expiry).toHaveValue("2028-07-15 18:30:45")
  } finally {
    if (id) await api.del(`/api/v1/open-apps/${id}`)
  }
})

test("既有失效时间按显示时区回显，编辑保存不偏移，清空后永不过期", async ({ authedPage: page, api }) => {
  const code = uniqueCode("E2E_TZ")
  const { id } = (await api.post("/api/v1/open-apps", {
    code, name: code, scopes: ["user:read"], expire_time: "2028-07-15T21:30:45.000Z",
  })) as { id: string }
  try {
    await page.goto(`/open/app?name=${code}`)
    const tab = page.locator('[data-tab="/_auth/open/app"]')
    await tab.getByTestId(`row-actions-${code}`).click()
    await page.getByTestId(`edit-${code}`).click()
    const expiry = page.getByRole("textbox", { name: "失效时间", exact: true })
    await expect(expiry).toHaveValue("2028-07-15 18:30:45")
    await page.getByTestId("open-app-name").fill(`${code}_EDIT`)
    await page.getByTestId("open-app-submit").click()
    await expect(page.getByTestId("open-app-submit")).toBeHidden()
    const saved = (await api.get(`/api/v1/open-apps/${id}`)) as { expire_time: string }
    expect(new Date(saved.expire_time).toISOString()).toBe("2028-07-15T21:30:45.000Z")

    await tab.getByTestId(`row-actions-${code}`).click()
    await page.getByTestId(`edit-${code}`).click()
    await expiry.fill("")
    await expiry.press("Enter")
    await page.getByTestId("open-app-submit").click()
    await expect(page.getByTestId("open-app-submit")).toBeHidden()
    expect((await api.get(`/api/v1/open-apps/${id}`)) as { expire_time: string | null }).toMatchObject({ expire_time: null })
    await expect(tab.getByRole("row").filter({ hasText: code })).toContainText("永不过期")
  } finally {
    await api.del(`/api/v1/open-apps/${id}`)
  }
})
