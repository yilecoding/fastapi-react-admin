import { expect, test } from "../fixtures/base"

/**
 * 命令面板（⌘/Ctrl+K）与快捷键帮助（?）。
 *
 * 条目 testid 里带雪花 ID（`command-palette-item-page:2049…`），换个库就变 ——
 * 所以这里一律按**可见文本**定位，别把种子数据的 ID 写进断言。
 */
test.describe("命令面板", () => {
  test("Ctrl+K 呼出 → 搜页面 → 回车跳过去", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await expect(page.getByTestId("command-trigger")).toBeVisible()

    await page.keyboard.press("Control+k")
    const palette = page.getByTestId("command-palette")
    await expect(palette).toBeVisible()

    await page.getByTestId("command-palette-input").fill("部门")
    // 面板里只剩部门那一条（「页面」组），回车直接跳
    await expect(palette.getByRole("option", { name: /部门管理/ })).toBeVisible()
    await page.keyboard.press("Enter")

    await expect(palette).toBeHidden()
    await expect(page).toHaveURL(/\/system\/dept/)
    // 跳过去之后标签条上应该多一个 tab（面板是导航入口，不是只改 URL）
    await expect(page.getByTestId("tab-bar")).toContainText("部门管理")

    // 再开一次：刚打开的页面进「已打开的标签页」组，且搜索词不残留
    await page.keyboard.press("Control+k")
    await expect(page.getByTestId("command-palette-input")).toHaveValue("")
    await expect(palette).toContainText("已打开的标签页")
    await page.keyboard.press("Escape")
    await expect(palette).toBeHidden()
  })

  test("? 打开快捷键帮助，但在输入框里打问号不能弹（单键快捷键的陷阱）", async ({
    authedPage: page,
  }) => {
    await page.goto("/dashboard")

    await page.keyboard.press("Shift+Slash")
    await expect(page.getByTestId("shortcuts-dialog")).toBeVisible()
    // 帮助里必须写着 ⌘/Ctrl+B —— 它以前只有作者知道
    await expect(page.getByTestId("shortcuts-dialog")).toContainText("折叠 / 展开侧边栏")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("shortcuts-dialog")).toBeHidden()

    // 🔴 回归：焦点在输入框里时 `?` 只能是一个字符，不能触发快捷键
    await page.keyboard.press("Control+k")
    const input = page.getByTestId("command-palette-input")
    await input.fill("")
    await page.keyboard.press("Shift+Slash")
    await expect(page.getByTestId("shortcuts-dialog")).toBeHidden()
    await expect(input).toHaveValue("?")
  })
})
