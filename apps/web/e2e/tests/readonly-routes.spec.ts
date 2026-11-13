import { request } from "@playwright/test"

import {
  API_BASE,
  createApiClient,
  expect,
  loginPageAs,
  loginToken,
  test,
  type ApiClient,
} from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

const pages = [
  {
    path: "/system/user",
    perm: "sys:user:list",
    api: "/api/v1/sys/users",
    write: "add-user",
  },
  {
    path: "/system/role",
    perm: "sys:role:list",
    api: "/api/v1/sys/roles",
    write: "role-detail-edit",
  },
  {
    path: "/system/menu",
    perm: "sys:menu:list",
    api: "/api/v1/sys/menus",
    write: "add-menu",
  },
  {
    path: "/system/dept",
    perm: "sys:dept:list",
    api: "/api/v1/sys/depts",
    write: "add-dept",
  },
  {
    path: "/system/data-permission",
    perm: "data:scope:list",
    api: "/api/v1/sys/data-scopes",
    write: "scope-detail-edit",
  },
  {
    path: "/log/opera",
    perm: "log:opera:list",
    api: "/api/v1/logs/opera",
    write: "clear-opera-logs",
  },
  {
    path: "/log/login",
    perm: "log:login:list",
    api: "/api/v1/logs/login",
    write: "clear-login-logs",
  },
  {
    path: "/plugins/dict",
    perm: "dict:type:list",
    api: "/api/v1/sys/dict-types",
    write: "add-data",
  },
  {
    path: "/plugins/config",
    perm: "sys:config:list",
    api: "/api/v1/sys/configs/all",
    write: "save-draft",
  },
  {
    path: "/scheduler/manage",
    perm: "task:scheduler:list",
    api: "/api/v1/tasks/schedulers",
    write: "add-scheduler",
  },
] as const

type MenuNode = {
  id: string
  path: string | null
  perms: string | null
  children?: MenuNode[] | null
}
const password = "ReadOnly!123456"

test.describe("只读页面入口权限 #323", () => {
  // 共用两套真实账号；每个测试仍使用独立的浏览器上下文。
  test.describe.configure({ mode: "default" })
  let api: ApiClient
  let dispose: () => Promise<void>
  const roleIds: string[] = []
  const userIds: string[] = []
  const usernames: string[] = []
  const readPerms: string[] = [...pages.map((p) => p.perm), "dict:data:list"]

  test.beforeAll(async () => {
    const client = await createApiClient()
    api = client.api
    dispose = client.dispose
    const tree = (await api.get("/api/v1/sys/menus")) as MenuNode[]
    const menuIds = new Set<string>()
    const readIds = new Set<string>()
    const foundPaths = new Set<string>()
    const foundPerms = new Set<string>()
    function collect(nodes: MenuNode[], ancestors: string[] = []) {
      for (const node of nodes) {
        const branch = [...ancestors, node.id]
        if (pages.some((p) => p.path === node.path)) {
          foundPaths.add(node.path!)
          for (const id of branch) menuIds.add(id)
        }
        if (node.perms && readPerms.includes(node.perms)) {
          foundPerms.add(node.perms)
          for (const id of branch) readIds.add(id)
        }
        collect(node.children ?? [], branch)
      }
    }
    collect(tree)
    expect([...foundPaths].sort()).toEqual(pages.map((p) => p.path).sort())
    expect([...foundPerms].sort()).toEqual([...readPerms].sort())
    const depts = (await api.get("/api/v1/sys/depts")) as { id: string }[]

    for (const withReadPerms of [true, false]) {
      const code = uniqueCode("E2ERO")
      await api.post("/api/v1/sys/roles", {
        code,
        name: code,
        status: 1,
        is_filter_scopes: false,
        remark: null,
      })
      const roles = (await api.get("/api/v1/sys/roles/all")) as {
        id: string
        code: string
      }[]
      const role = roles.find((r) => r.code === code)
      expect(role).toBeTruthy()
      roleIds.push(role!.id)
      await api.put(`/api/v1/sys/roles/${role!.id}/menus`, {
        menus: [...new Set([...menuIds, ...(withReadPerms ? readIds : [])])],
      })
      const user = (await api.post("/api/v1/sys/users", {
        username: code,
        password,
        nickname: code,
        dept_id: depts[0].id,
        roles: [role!.id],
      })) as { id: string }
      userIds.push(user.id)
      usernames.push(code)

      // 明确证明这是普通账号，权限来自真实角色绑定，避免超管免检导致假绿。
      const ctx = await request.newContext({ baseURL: API_BASE })
      try {
        const { token } = await loginToken(ctx, code, password)
        const headers = { Authorization: `Bearer ${token}` }
        const me = await (
          await ctx.get("/api/v1/sys/users/me", { headers })
        ).json()
        expect(me.data.is_superuser).toBe(false)
        const codes = await (
          await ctx.get("/api/v1/auth/codes", { headers })
        ).json()
        expect(codes.data.sort()).toEqual(
          withReadPerms ? [...readPerms].sort() : []
        )
      } finally {
        await ctx.dispose()
      }
    }
  })

  test.afterAll(async () => {
    if (!api) return
    try {
      for (const id of userIds) await api.del(`/api/v1/sys/users/${id}`)
      if (roleIds.length) await api.del("/api/v1/sys/roles", { pks: roleIds })
    } finally {
      await dispose()
    }
  })

  for (const item of pages) {
    test(`${item.path}：只有查询权限可访问，写操作不可用`, async ({ page }) => {
      await loginPageAs(page, usernames[0], password)
      const loaded = page.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === item.api &&
          r.request().method() === "GET"
      )
      await page.goto(item.path)
      const response = await loaded
      expect(response.status()).toBe(200)
      expect((await response.json()).code).toBe(200)
      const tab = page.locator(`[data-tab="/_auth${item.path}"]`)
      await expect(tab).toBeVisible()
      await expect(page).toHaveURL((url) => url.pathname === item.path)
      await expect(tab.getByTestId(item.write)).toHaveCount(0)
    })

    test(`${item.path}：只有菜单、没有查询权限仍跳转 403`, async ({ page }) => {
      await loginPageAs(page, usernames[1], password)
      await page.goto(item.path)
      await expect(page).toHaveURL(/\/403\?/)
      const url = new URL(page.url())
      expect(url.searchParams.get("from")).toBe(item.path)
      expect(url.searchParams.get("need")).toBe(item.perm)
    })
  }
})
