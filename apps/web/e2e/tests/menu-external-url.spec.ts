import { API_BASE, expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

type Menu = { id: string; name: string; link: string; children?: Menu[] }
const MENUS = "/api/v1/sys/menus"
const URL_ERROR = "外链/内嵌地址必须是完整的 http(s) 地址"

function flatten(menus: Menu[]): Menu[] {
  return menus.flatMap((menu) => [menu, ...flatten(menu.children ?? [])])
}

for (const type of ["外链", "内嵌"]) {
  test(`${type}菜单拒绝系统协议，HTTP 地址保存并重载后仍能打开`, async ({
    authedPage: page,
    api,
  }) => {
    const name = `E2EExternal${uniqueCode("M").replaceAll("_", "")}`
    const link = `${API_BASE}/docs`
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
      await create.getByTestId("m-link").fill("file://///attacker/share/x.exe")
      await create.getByTestId("m-submit").click()
      await expect(create.getByText(URL_ERROR, { exact: true })).toBeVisible()

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
      await expect(edit.getByText(URL_ERROR, { exact: true })).toBeVisible()
      await edit.getByRole("button", { name: "取消", exact: true }).click()
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
        await expect(page.locator(`iframe[src="${link}"]`)).toBeVisible()
      }
    } finally {
      const menus = flatten((await api.get(MENUS)) as Menu[])
      for (const menu of menus.filter((row) => row.name === name)) {
        await api.del(`${MENUS}/${menu.id}`)
      }
    }
  })
}
