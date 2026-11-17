import { expect, test } from "../fixtures/base"

const failure = {
  status: 502,
  contentType: "application/json",
  body: JSON.stringify({ code: 502, msg: "gateway failed (E2E)", data: null }),
}

test.describe("只读页面取数失败", () => {
  test("角色用户：显示错误块，不显示人数/空态，并可重试", async ({
    authedPage: page,
    api,
  }) => {
    const roles = (await api.get("/api/v1/sys/roles/all")) as {
      id: string
      name: string
    }[]
    const role = roles[0]
    expect(role).toBeTruthy()
    const users = (await api.get(
      `/api/v1/sys/users?role=${role.id}&page=1&size=10`
    )) as { total: number; items: { username: string }[] }
    let fail = true
    await page.route(
      (url) =>
        url.pathname === "/api/v1/sys/users" && url.searchParams.has("role"),
      (route) => (fail ? route.fulfill(failure) : route.fallback())
    )

    await page.goto(`/system/role?role=${role.id}&tab=users`)
    const panel = page.getByTestId("role-users")
    await expect(panel.getByTestId("query-error")).toBeVisible()
    await expect(panel.getByTestId("role-users-hint")).toHaveCount(0)
    await expect(panel.getByTestId("role-users-table")).not.toContainText(
      "还没有用户持有这个角色"
    )
    await expect(panel.getByTestId("role-users-add")).toBeDisabled()

    fail = false
    await panel.getByTestId("query-error-retry").click()
    await expect(panel.getByTestId("query-error")).toBeHidden()
    await expect(panel.getByTestId("role-users-table")).toHaveAttribute(
      "aria-busy",
      "false"
    )
    await expect(panel.getByTestId("role-users-hint")).toContainText(
      `共 ${users.total} 人持有「${role.name}」`
    )
    if (users.items.length) {
      for (const user of users.items) {
        await expect(
          panel.getByTestId(`role-user-${user.username}`)
        ).toBeVisible()
      }
    } else {
      await expect(panel.getByTestId("role-users-table")).toContainText(
        "还没有用户持有这个角色"
      )
    }
    await expect(panel.getByTestId("role-users-add")).toBeEnabled()
  })

  test("参数配置：显示错误块，不显示分类空态，并可重试", async ({
    authedPage: page,
  }) => {
    let fail = true
    await page.route(
      (url) => url.pathname === "/api/v1/sys/configs/all",
      (route) => (fail ? route.fulfill(failure) : route.fallback())
    )

    await page.goto("/plugins/config")
    const error = page.getByTestId("query-error")
    await expect(error).toBeVisible()
    await expect(page.getByTestId("panel-empty")).toHaveCount(0)
    await expect(page.getByTestId("add-config")).toBeDisabled()
    await expect(page.getByTestId("save-draft")).toBeDisabled()

    fail = false
    await error.getByTestId("query-error-retry").click()
    await expect(error).toBeHidden()
    await expect(page.getByTestId("panel-title")).toBeVisible()
    await expect(page.getByTestId("config-skeleton")).toHaveCount(0)
    await expect(
      page.locator('[data-testid^="setting-"]').first()
    ).toBeVisible()
    await expect(page.getByTestId("add-config")).toBeEnabled()
  })
})
