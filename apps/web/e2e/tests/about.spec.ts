import type { Page } from "@playwright/test"

import { expect, test } from "../fixtures/base"

/**
 * 帮助菜单里的「关于」：前后端各是哪个版本、哪个提交（#378，`shell/about-dialog.tsx`）。
 *
 * 后两条造假响应是**必要**的，理由同 `new-version.spec.ts`：「前后端不是同一版」和
 * 「再次打开时后端挂了」在一套正常起着的环境里都不会自己发生。
 */
const ABOUT = "**/api/v1/sys/dashboard/about"

const reply = (version: string, commit: string | null) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ code: 200, msg: "ok", data: { version, commit } }),
})

async function openAbout(page: Page) {
  await page.getByTestId("help-menu").click()
  await page.getByTestId("help-about").click()
  await expect(page.getByTestId("about-dialog")).toBeVisible()
}

test.describe("关于", () => {
  test("并排显示前后端版本；同一版时不报不一致", async ({ authedPage: page }) => {
    await page.goto("/dashboard")
    await openAbout(page)

    const frontend = page.getByTestId("about-frontend")
    const backend = page.getByTestId("about-backend")
    await expect(frontend).toContainText(/^v\d+\.\d+\.\d+/)
    // 真后端：版本号和前端是同一个（release.yml 校验两处同值）。只比版本号 ——
    // 开发期后端没有 GIT_SHA，提交号那一半是空的，而这不算「不一致」
    const version = (await frontend.innerText()).split(" ")[0]
    await expect(backend).toContainText(version)
    await expect(page.getByTestId("about-mismatch")).toHaveCount(0)
    await expect(page.getByTestId("about-error")).toHaveCount(0)
  })

  test("后端是另一个版本 → 标出不一致", async ({ authedPage: page }) => {
    await page.route(ABOUT, (route) => route.fulfill(reply("0.0.1", "deadbee")))
    await page.goto("/dashboard")
    await openAbout(page)

    await expect(page.getByTestId("about-backend")).toContainText("v0.0.1 · deadbee")
    await expect(page.getByTestId("about-mismatch")).toBeVisible()
  })

  test("再次打开时取不到 → 显示错误，不拿上一次的版本顶替", async ({ authedPage: page }) => {
    // 🔴 react-query 在重查失败时会留着上一次的 data。不处理的话这里会静默显示 `v9.9.9`，
    // 错误块不出 —— 用户以为看到的是此刻的后端版本（硬纪律 9，#379 评审）
    let healthy = true
    await page.route(ABOUT, (route) =>
      healthy ? route.fulfill(reply("9.9.9", null)) : route.fulfill({ status: 500, body: "boom" })
    )
    await page.goto("/dashboard")
    await openAbout(page)
    await expect(page.getByTestId("about-backend")).toContainText("v9.9.9")

    await page.keyboard.press("Escape")
    await expect(page.getByTestId("about-dialog")).toHaveCount(0)
    healthy = false
    await openAbout(page)

    // 重试一次之后才落到错误态，给够时间
    await expect(page.getByTestId("about-error")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("about-backend")).not.toContainText("9.9.9")
    await expect(page.getByTestId("about-backend")).toContainText("获取失败")
    // 版本拿不到就判断不了，不能顺手报一个「不一致」
    await expect(page.getByTestId("about-mismatch")).toHaveCount(0)
  })
})
