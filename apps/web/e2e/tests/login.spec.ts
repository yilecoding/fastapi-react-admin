import { expect, test } from "@playwright/test"

// 这一份不用 fixtures/base 的 authedPage —— 测的正是「从没登录的状态走真实表单」，
// 用已经注入 token 的页面就测不到这条路径了。
// 验证码在 global-setup.ts 里已经关掉，走真实表单时不用管那道坎。

test.describe("登录", () => {
  test("账号或密码错误时报错可见", async ({ page }) => {
    await page.goto("/sign-in")
    await page.getByTestId("username").fill("admin")
    await page.getByTestId("password").fill("this-is-definitely-wrong")
    await page.getByTestId("submit").click()

    // 硬纪律 9：请求失败必须是可见状态，不是缺失状态
    await expect(page.getByTestId("login-error")).toBeVisible()
    await expect(page).toHaveURL(/\/sign-in/)
  })

  test("账号密码正确时登录成功并进入工作台", async ({ page }) => {
    await page.goto("/sign-in")
    await page.getByTestId("username").fill("admin")
    await page.getByTestId("password").fill("123456")
    await page.getByTestId("submit").click()

    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByTestId("page-title")).toBeVisible()
  })
})
