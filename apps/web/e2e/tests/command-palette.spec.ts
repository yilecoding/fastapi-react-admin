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
    // 🔴 按全局快捷键之前必须先等外壳挂上来。`goto` 只等到 `load`，而 `?` 的
    // 监听是 `CommandMenu` 的 effect 注册的 —— React 还没提交时按下去，
    // 那一次按键**谁也收不到**，面板不会弹。
    // 症状会骗人：单跑这个文件永远绿（vite 已经热了、机器也不忙），
    // 只有整套跑（`pnpm e2e`，54 条、3 分钟）才偶发红，看着像「快捷键坏了」。
    // `command-trigger` 和 `CommandMenu` 是 `_auth.tsx` 里的兄弟节点，
    // 它可见就说明那次提交已经发生 —— 上面第一条测试一直这么等。
    await expect(page.getByTestId("command-trigger")).toBeVisible()

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
