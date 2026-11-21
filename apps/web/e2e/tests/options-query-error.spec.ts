/**
 * #397：取数失败被默认值吞成「没有」的 8 处。
 *
 * 每条都是同一个形状：`page.route` 把**那一个**接口打成 502 → 断言看到的是错误 + 重试，
 * 而不是空下拉 / 空态 / 编出来的默认值 → 放行 → 点重试 → 数据回来。
 * 接口正常时对错两种写法渲染结果完全一样，不造失败就等于没测（e2e 分册 `list-error.spec.ts` 那条）。
 */
import type { Page } from "@playwright/test"

import { expect, loginPageAs, test, type ApiClient } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

const failure = {
  status: 502,
  contentType: "application/json",
  body: JSON.stringify({ code: 502, msg: "gateway failed (E2E)", data: null }),
}

/** 只拦 `match` 命中的那个接口；`state.fail = false` 之后放行到真后端 */
async function failOnce(page: Page, match: (url: URL) => boolean) {
  const state = { fail: true }
  await page.route(match, (route) => (state.fail ? route.fulfill(failure) : route.fallback()))
  return state
}

const PASSWORD = "E2e_397_pass"

async function createStaff(api: ApiClient) {
  const roles = (await api.get("/api/v1/sys/roles/all")) as { id: string; name: string }[]
  const staffRole = roles.find((r) => r.name === "普通员工")!.id
  type DeptNode = { id: string; children?: DeptNode[] }
  const tree = (await api.get("/api/v1/sys/depts")) as DeptNode[]
  const username = `e2e397_${uniqueCode("U").slice(2).toLowerCase()}`.slice(0, 30)
  const user = (await api.post("/api/v1/sys/users", {
    username,
    password: PASSWORD,
    nickname: username,
    email: `${username}@e2e.example.com`,
    dept_id: tree[0]!.id,
    roles: [staffRole],
  })) as { id: string }
  return { id: user.id, username }
}

test.describe("选项 / 外壳取数失败要说出来（#397）", () => {
  test("用户表单：角色取不到显示错误 + 重试，不说「暂无可分配角色」", async ({ authedPage: page, api }) => {
    const roles = (await api.get("/api/v1/sys/roles/all")) as { name: string }[]
    const gate = await failOnce(page, (u) => u.pathname === "/api/v1/sys/roles/all")

    await page.goto("/system/user")
    await page.getByTestId("add-user").click()
    const err = page.getByTestId("f-roles-error")
    await expect(err).toBeVisible()
    await expect(page.getByText("暂无可分配角色")).toHaveCount(0)

    gate.fail = false
    await page.getByTestId("f-roles-error-retry").click()
    await expect(err).toBeHidden()
    await expect(page.getByTestId(`f-role-${roles[0]!.name}`)).toBeVisible()
  })

  test("插件页：列表取不到显示错误块，不说「没有已安装的插件」", async ({ authedPage: page }) => {
    const gate = await failOnce(page, (u) => u.pathname === "/api/v1/sys/plugins")

    await page.goto("/system/plugin")
    const err = page.getByTestId("plugin-error")
    await expect(err).toBeVisible()
    await expect(page.getByTestId("plugin-empty")).toHaveCount(0)

    gate.fail = false
    await err.getByTestId("plugin-error-retry").click()
    await expect(err).toBeHidden()
    await expect(page.getByTestId("plugin-grid").or(page.getByTestId("plugin-empty"))).toBeVisible()
  })

  test("侧边栏 / ⌘K：菜单取不到时两处都说出来，重试后恢复", async ({ authedPage: page }) => {
    const gate = await failOnce(page, (u) => u.pathname === "/api/v1/sys/menus/sidebar")

    // 深链进一个不是工作台的页面：工作台自己有 contextError，别的页面只有侧边栏这一处
    await page.goto("/profile")
    const err = page.getByTestId("sidebar-error")
    await expect(err).toBeVisible()

    await page.getByTestId("command-trigger").click()
    const palette = page.getByTestId("command-palette")
    await expect(palette.getByText("菜单加载失败，点此重试")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(palette).toBeHidden()

    gate.fail = false
    await err.click()
    await expect(err).toBeHidden()
    await expect(page.getByTestId("sidebar-nav").locator("a").first()).toBeVisible()
  })

  test("权限码：非超管在无守卫页面上取不到权限码时有提示，重试后消失", async ({ authedPage: page, api }) => {
    test.slow()
    const staff = await createStaff(api)
    try {
      const gate = await failOnce(page, (u) => u.pathname === "/api/v1/auth/codes")
      await page.context().clearCookies()
      await loginPageAs(page, staff.username, PASSWORD)
      await page.goto("/profile")
      const err = page.getByTestId("perm-codes-error")
      await expect(err).toBeVisible()

      gate.fail = false
      await err.click()
      await expect(err).toBeHidden()
    } finally {
      await api.del(`/api/v1/sys/users/${staff.id}`).catch(() => {})
    }
  })

  test("任务调度表单：meta 取不到时不拿 UTC 顶上，预览不画", async ({ authedPage: page }) => {
    const gate = await failOnce(page, (u) => u.pathname === "/api/v1/tasks/schedulers/meta")

    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()
    await expect(page.getByTestId("cron-expr")).toHaveValue("* * * * *")
    const err = page.getByTestId("s-meta-error")
    await expect(err).toBeVisible()
    await expect(page.getByTestId("cron-next-runs")).toHaveCount(0)

    gate.fail = false
    await page.getByTestId("s-meta-error-retry").click()
    await expect(err).toBeHidden()
    await expect(page.getByTestId("cron-next-runs")).toBeVisible()
  })

  test("数据规则表单：字段列表取不到时不退化成自由输入", async ({ authedPage: page, api }) => {
    const scopes = (await api.get("/api/v1/sys/data-scopes/all")) as { id: string }[]
    const models = (await api.get("/api/v1/sys/data-rules/models")) as string[]
    const model = models.find((m) => m !== "__ALL__")!
    const gate = await failOnce(page, (u) => /^\/api\/v1\/sys\/data-rules\/models\/[^/]+\/columns$/.test(u.pathname))

    await page.goto(`/system/data-permission?scope=${scopes[0]!.id}`)
    await page.getByTestId("rule-add").click()
    await page.getByTestId("dr-model").click()
    await page.getByRole("option", { name: model, exact: true }).click()
    const err = page.getByTestId("dr-column-error")
    await expect(err).toBeVisible()
    await expect(page.getByTestId("dr-column")).toHaveAttribute("readonly", "")

    gate.fail = false
    await page.getByTestId("dr-column-error-retry").click()
    await expect(err).toBeHidden()
    // 取回来之后是下拉，不是输入框
    await expect(page.getByTestId("dr-column")).not.toHaveAttribute("readonly", "")
    await expect(page.getByTestId("dr-column")).toHaveAttribute("role", "combobox")
  })

  test("审批：重新发起时原单取不到显示错误，不给空白表单；设计器角色目录取不到有提示", async ({
    authedPage: page,
    api,
  }) => {
    test.slow()
    const code = uniqueCode("E2E397")
    const me = (await api.get("/api/v1/sys/users/me")) as { id: string }
    const def = (await api.post("/api/v1/sys/workflow/definitions", {
      code,
      name: code,
      form: { schemaVersion: 1, fields: [{ id: "reason", type: "text", label: "事由" }] },
      model: {
        schemaVersion: 1,
        root: {
          type: "start", id: "start",
          next: {
            type: "approval", id: "approve", name: "审批", mode: "any",
            assignee: { kind: "user", user_ids: [me.id] }, onEmpty: "reject", next: null,
          },
        },
      },
    })) as { id: string }
    try {
      await api.post(`/api/v1/sys/workflow/definitions/${def.id}/publish`)
      const started = (await api.post("/api/v1/sys/workflow/instances", {
        code, form: { reason: `原单-${code}` }, key: code,
      })) as { instance_id: string }

      // ── 重新发起：原单详情 502 ──
      const gate = await failOnce(page, (u) => u.pathname === `/api/v1/sys/workflow/instances/${started.instance_id}`)
      await page.goto(`/workflow/inbox?start=${code}&from=${started.instance_id}`)
      const sheet = page.getByTestId("wf-start-sheet")
      const err = sheet.getByTestId("wf-start-from-error")
      await expect(err).toBeVisible()
      gate.fail = false
      await err.getByTestId("wf-start-from-error-retry").click()
      await expect(err).toBeHidden()
      await expect(sheet.locator("input, textarea").first()).toHaveValue(`原单-${code}`)

      // ── 设计器：角色目录 502 ──
      let rolesFail = true
      await page.route(
        (u) => u.pathname === "/api/v1/sys/workflow/directory/roles",
        (route) => (rolesFail ? route.fulfill(failure) : route.fallback())
      )
      await page.goto(`/workflow/definition?id=${def.id}&step=flow&sel=approve`)
      await page.getByTestId("node-rule-kind-role").click()
      const rolesErr = page.getByTestId("node-rule-roles-error")
      await expect(rolesErr).toBeVisible()
      rolesFail = false
      await page.getByTestId("node-rule-roles-error-retry").click()
      await expect(rolesErr).toBeHidden()
    } finally {
      await api.put(`/api/v1/sys/workflow/definitions/${def.id}/status`, { enabled: false }).catch(() => {})
    }
  })
})
