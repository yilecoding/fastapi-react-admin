import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 消息通知中心（铃铛 + 未读红点）。
 *
 * 这一整块此前没有任何 E2E。它的两条硬约束都写在
 * `pages/notification/AGENTS.md` 里，而**两条的失败方式都是静默的**：
 *
 * 1. **红点必须能靠 REST 拿到正确值，不能只靠 socket。** 只靠推送的话，
 *    断线期间到达的通知在红点上**永远看不见**，界面上没有任何异常
 *    ——`use-presence.ts` 的哲学就是「连不上不报错、不影响业务」。
 * 2. **未读数取数失败时角标要显示 `!`**，不能什么都不显示 —— 后者和
 *    「一条未读都没有」长得一模一样（硬纪律 9）。
 *
 * 第一条的测法是**时序**上的：通知在页面存在之前就发出去了，那一刻的 socket
 * 事件根本没有接收方，所以页面加载后能看到正确的未读数，只可能来自 REST。
 * 不需要真的去断网。
 */

type Me = { id: string }

test.describe("消息通知中心", () => {
  // 🔴 **必须 serial。** `playwright.config.ts` 是 `fullyParallel: true`，同一个文件里的
  // 用例会被分到不同 worker 并行跑；而这三条断言的是 admin 的**未读数**——一个
  // 全局单值。并行时第三条造的 2 条通知会把第一条的 `toHaveText("1")` 顶成 "3"。
  //
  // ⚠️ 本地跑不出来：非 CI 时 `workers: 1`，顺序执行天然没有这个问题，
  // 只有 CI 上才会红（同 `data-permission.spec.ts` 那条 serial 的理由）。
  test.describe.configure({ mode: "serial" })

  // admin 在 fba_test 里是共用账号，未读数是全局状态：每条测试开头先 read-all
  // 清零，结束时也清一次，把这条测试对别人的影响收干净。
  test.beforeEach(async ({ api }) => {
    await api.put("/api/v1/sys/notifications/read-all")
  })

  test.afterEach(async ({ api }) => {
    await api.put("/api/v1/sys/notifications/read-all")
  })

  test("🔴 通知在页面加载之前就发出去了，红点照样是对的（走 REST，不是靠推送）", async ({
    authedPage: page,
    api,
  }) => {
    const me = (await api.get("/api/v1/sys/users/me")) as Me
    const title = `E2E通知-${uniqueCode("N")}`

    // 页面还不存在的时候就发 —— 这一刻的 socket 事件没有任何接收方
    await api.post("/api/v1/sys/notifications/send", {
      title,
      content: "端到端测试用，读完即焚",
      category: 0,
      link: null,
      recipient_ids: [me.id],
    })

    await page.goto("/dashboard")
    // 未读数只可能来自登录后那一次 unread-count 请求
    await expect(page.getByTestId("notification-badge")).toHaveText("1")

    await page.getByTestId("notification-bell").click()
    await expect(page.getByTestId("notification-panel")).toBeVisible()
    // 按文本挑，不按顺序 —— 下拉里混着已读的历史通知，顺序不是这条测试要断言的东西
    await expect(page.getByTestId("notification-item").filter({ hasText: title })).toBeVisible()

    // 全部已读 → 红点消失（角标只在 total > 0 时渲染）
    await page.getByTestId("notification-mark-all").click()
    await expect(page.getByTestId("notification-badge")).toBeHidden()
  })

  test("🔴 未读数接口挂了要显示 `!`，不能悄悄不显示红点", async ({ authedPage: page }) => {
    // 只拦未读数这一个端点：通知列表、侧边栏菜单等等都要正常，
    // 否则分不清 `!` 是哪个请求失败带出来的
    await page.route(/\/api\/v1\/sys\/notifications\/unread-count/, (route) =>
      route.fulfill({ status: 502, contentType: "application/json", body: '{"msg":"boom"}' })
    )

    await page.goto("/dashboard")

    // 「什么都不显示」和「一条未读都没有」长得一模一样 —— 所以失败必须是
    // 一个**可见的**状态，而不是缺失状态（硬纪律 9）
    await expect(page.getByTestId("notification-badge-error")).toBeVisible()
    await expect(page.getByTestId("notification-badge")).toBeHidden()
  })

  test("列表页的「全部标为已读」跟红点是同一份真值", async ({ authedPage: page, api }) => {
    const me = (await api.get("/api/v1/sys/users/me")) as Me
    for (let i = 0; i < 2; i++) {
      await api.post("/api/v1/sys/notifications/send", {
        title: `E2E通知-${uniqueCode("N")}-${i}`,
        content: "端到端测试用",
        category: 1,
        link: null,
        recipient_ids: [me.id],
      })
    }

    await page.goto("/notification")
    await expect(page.getByTestId("notification-badge")).toHaveText("2")
    await expect(page.getByTestId("notification-table")).toBeVisible()

    // 列表页那个按钮走二次确认（一次点掉所有未读，不可撤销）
    await page.getByTestId("notification-mark-all-page").click()
    await expect(page.getByTestId("confirm-dialog")).toBeVisible()
    await page.getByTestId("confirm-ok").click()

    // 页面上的操作要让外壳里的红点跟着变 —— 两处读的是同一个 query，
    // 少了失效就会出现「列表全是已读、红点还挂着 2」这种自相矛盾的界面
    await expect(page.getByTestId("notification-badge")).toBeHidden()
  })
})
