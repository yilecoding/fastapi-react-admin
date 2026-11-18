import { API_BASE, expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

type Menu = { id: string; name: string; link: string; children?: Menu[] }
const MENUS = "/api/v1/sys/menus"
const LINK_ERROR = "外链地址必须是完整的 http(s) 地址"
const EMBEDDED_ERROR = "内嵌地址必须是完整的 http(s) 地址或同源根相对路径"

function flatten(menus: Menu[]): Menu[] {
  return menus.flatMap((menu) => [menu, ...flatten(menu.children ?? [])])
}

for (const { type, address, link } of [
  { type: "外链", address: "HTTP", link: `${API_BASE}/docs` },
  { type: "内嵌", address: "HTTP", link: `${API_BASE}/docs` },
  { type: "内嵌", address: "同源根相对", link: "/favicon.svg" },
]) {
  test(`${type}菜单拒绝危险地址，${address}地址保存并重载后仍能打开`, async ({
    authedPage: page,
    api,
  }) => {
    // 创建、编辑与多次整页刷新走完整链路；CI 外链实测 26s，内嵌在最后一次刷新耗尽默认 30s。
    test.slow()
    const name = `E2EExternal${uniqueCode("M").replaceAll("_", "")}`
    const urlError = type === "外链" ? LINK_ERROR : EMBEDDED_ERROR
    try {
      await page.goto("/system/menu")
      await page.getByTestId("add-menu").click()
      const create = page.getByRole("dialog", { name: "新增菜单" })
      await create.getByTestId("m-type").click()
      await page.getByRole("option", { name: type, exact: true }).click()
      await create.getByTestId("m-title").fill(name)
      await create.getByTestId("m-name").fill(name)
      await create.getByTestId("m-path").click()
      await page.getByRole("option", { name: "/profile", exact: true }).click()
      const rejected = ["file://///attacker/share/x.exe", "//attacker.example/page"]
      if (type === "外链") rejected.push("/favicon.svg")
      else {
        await expect(create.getByText("Web 端支持 /help 这样的同源根相对路径。桌面客户端需填写完整的 http(s) 地址。", { exact: true })).toBeVisible()
        rejected.push("help", "./x", "docs/a")
      }
      for (const invalid of rejected) {
        await create.getByTestId("m-link").fill(invalid)
        await create.getByTestId("m-submit").click()
        await expect(create.getByText(urlError, { exact: true })).toBeVisible()
      }

      await create.getByTestId("m-link").fill(link)
      await create.getByTestId("m-submit").click()
      await expect(create).toBeHidden()
      await page.reload()
      await expect(page.getByTestId(`menu-row-${name}`)).toBeVisible()
      const menu = flatten((await api.get(MENUS)) as Menu[]).find(
        (row) => row.name === name
      )
      expect(menu).toBeDefined()
      expect(menu!.link).toBe(link)

      await page
        .getByRole("button", { name: `操作 ${name}`, exact: true })
        .click()
      await page.getByTestId(`menu-edit-${name}`).click()
      const edit = page.getByRole("dialog", { name: "编辑菜单" })
      await expect(edit.getByTestId("m-link")).toHaveValue(link)
      await edit.getByTestId("m-link").fill("search-ms:probe")
      await edit.getByTestId("m-submit").click()
      await expect(edit.getByText(urlError, { exact: true })).toBeVisible()
      expect(((await api.get(`${MENUS}/${menu!.id}`)) as Menu).link).toBe(link)
      await edit.getByTestId("m-link").fill(link)
      await edit.getByTestId("m-submit").click()
      await expect(edit).toBeHidden()
      await page.reload()
      await expect(page.getByTestId(`menu-row-${name}`)).toBeVisible()
      expect(((await api.get(`${MENUS}/${menu!.id}`)) as Menu).link).toBe(link)

      const sidebar = page.locator('[data-sidebar="sidebar"]')
      if (type === "外链") {
        const opened = page.waitForEvent("popup")
        await sidebar.getByRole("link", { name, exact: true }).click()
        const popup = await opened
        await expect(popup).toHaveURL(link)
        await popup.close()

        await page
          .getByRole("button", { name: "打开命令面板", exact: true })
          .click()
        const command = page.getByRole("dialog", { name: "命令面板" })
        await command.getByPlaceholder("搜索页面、标签页与操作…").fill(name)
        const commandOpened = page.waitForEvent("popup")
        await command.getByRole("option").filter({ hasText: name }).click()
        const commandPopup = await commandOpened
        await expect(commandPopup).toHaveURL(link)
        await commandPopup.close()
      } else {
        await sidebar.getByRole("link", { name, exact: true }).click()
        await expect(page).toHaveURL(new RegExp(`/embedded/${name}$`))
        const src = new URL(link, page.url()).href
        const frame = page.getByTestId("embedded-frame")
        await expect(frame).toBeVisible()
        await expect(frame).toHaveAttribute("src", src)
        // iframe 文档可能引用站外资源；等宿主 DOM 后，下面的断言等待实际内容。
        await page.reload({ waitUntil: "domcontentloaded" })
        await expect(page.getByTestId("embedded-frame")).toHaveAttribute("src", src)
        if (link.startsWith("/")) {
          await expect(page.frameLocator('[data-testid="embedded-frame"]').locator("svg")).toBeVisible()
        }
      }
    } finally {
      const menus = flatten((await api.get(MENUS)) as Menu[])
      for (const menu of menus.filter((row) => row.name === name)) {
        await api.del(`${MENUS}/${menu.id}`)
      }
    }
  })
}

test("模拟桌面桥：相对内嵌菜单显示平台限制和修改方式", async ({
  authedPage: page,
  api,
}) => {
  const name = `E2EDesktop${uniqueCode("M").replaceAll("_", "")}`
  await api.post(MENUS, {
    name, title: name, type: 3, path: "/profile", link: "/favicon.svg",
    sort: 0, status: 1, display: 1,
  })
  try {
    // 先走真实 Web 会话恢复，再设置能力标记；此用例不模拟 Electron IPC/认证。
    await page.goto("/system/menu")
    const link = page.locator('[data-sidebar="sidebar"]').getByRole("link", { name, exact: true })
    await expect(link).toBeVisible()
    await page.evaluate(() => Object.defineProperty(window, "desktop", { value: {}, configurable: true }))
    await link.click()
    await expect(page.getByTestId("embedded-notice")).toContainText(
      "桌面客户端无法加载相对内嵌地址。请到「菜单管理」将地址改为完整的 http(s) 地址，或在 Web 端打开。"
    )
    await expect(page.getByTestId("embedded-frame")).toHaveCount(0)
  } finally {
    const menus = flatten((await api.get(MENUS)) as Menu[])
    for (const menu of menus.filter((row) => row.name === name)) {
      await api.del(`${MENUS}/${menu.id}`)
    }
  }
})
