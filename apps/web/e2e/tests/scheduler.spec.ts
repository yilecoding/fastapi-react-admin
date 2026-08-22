import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

/**
 * 定时任务两页的回归。
 *
 * 选题不是「把界面点一遍」，而是照仓库的规矩：**只测坏起来是静默的**。
 * 这一套里静默失败特别多，因为「调度」的错误反馈天然是滞后的 ——
 * 配错了不会当场报错，只会在某个凌晨三点该跑没跑。
 *
 * ⚠️ 数据一律走接口造（`api` fixture），只有被测的那一步走 UI。
 */

const BASE = "/api/v1/tasks/schedulers"

test.describe("任务调度", () => {
  test("新增 → cron 构建器 → 列表说人话 → 启停 → 删除二次确认", async ({ authedPage: page }) => {
    const name = `E2E调度${uniqueCode("S")}`

    await page.goto("/scheduler/manage")
    await expect(page.getByTestId("page-title")).toHaveText("任务调度")

    await page.getByTestId("add-scheduler").click()
    await page.getByTestId("s-name").fill(name)

    // 🔴 任务名只能选不能敲。打错一个字就是「调度按时触发、worker 收到
    // 不认识的名字」—— celery 只记一条 Received unregistered task，
    // 而界面上「累计触发」照涨，看起来一切正常
    await page.getByTestId("s-task").click()
    await page.getByRole("option", { name: "maintenance.prune_logs" }).click()

    // cron 构建器只往表达式框里写；表达式框才是唯一真值
    await expect(page.getByTestId("cron-expr")).toHaveValue("* * * * *")
    await page.getByTestId("cron-preset").click()
    await page.getByRole("option", { name: "每天" }).click()
    await expect(page.getByTestId("cron-expr")).toHaveValue("0 0 * * *")
    await page.getByTestId("cron-hour").fill("3")
    await page.getByTestId("cron-minute").fill("15")
    await expect(page.getByTestId("cron-expr")).toHaveValue("15 3 * * *")

    await page.getByTestId("s-submit").click()

    // 列表里「触发策略」说人话而不是显示原文 —— 这一列的作用就是让人
    // 一眼确认「是不是按我想的时间跑」，`15 3 * * *` 对多数人不可读
    const row = page.locator("tbody tr", { hasText: name })
    await expect(row).toBeVisible()
    await expect(row).toContainText("每天 03:15")

    // 启停走独立接口 —— 不需要把整个对象回传（回传会读漏字段清掉数据）
    const toggle = row.locator('[data-testid^="toggle-scheduler-"]')
    await expect(toggle).toBeVisible()
    await toggle.click()
    await page.reload()
    await expect(
      page.locator("tbody tr", { hasText: name }).locator('[data-testid^="toggle-scheduler-"]')
    ).not.toBeChecked()

    // 删除必须过二次确认，不能一点就没
    await page.locator("tbody tr", { hasText: name }).locator('[data-testid^="del-scheduler-"]').click()
    await expect(page.getByTestId("confirm-dialog")).toBeVisible()
    await page.getByTestId("confirm-ok").click()
    await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0)
  })

  test("cron 表达式框是唯一真值，构建器覆盖不到的写法不会被改掉", async ({ authedPage: page }) => {
    /**
     * 🔴 这条防的是「构建器反过来当真值」那种实现。
     *
     * 步进 / 区间 / 枚举（每 5 分钟、1-5、1,15）是 crontab 存在的理由，
     * 而它们落在四个预设之外。构建器一旦把它们规范化掉，用户配的
     * 「每 5 分钟」会静默变成「每分钟」或「每小时第 5 分」——
     * 界面上看着像存住了，实际跑的完全是另一个节奏。
     */
    const name = `E2E步进${uniqueCode("S")}`

    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()
    await page.getByTestId("s-name").fill(name)
    await page.getByTestId("s-task").click()
    await page.getByRole("option", { name: "maintenance.prune_logs" }).click()

    const stepped = "*/5 * * * *"
    await page.getByTestId("cron-expr").fill(stepped)
    // 预设应该退到「自定义」，并且**不去改**表达式
    await expect(page.getByTestId("cron-preset")).toContainText("自定义")
    await expect(page.getByTestId("cron-expr")).toHaveValue(stepped)

    await page.getByTestId("s-submit").click()
    const row = page.locator("tbody tr", { hasText: name })
    await expect(row).toBeVisible()

    // 存进去的必须还是原表达式 —— 重新打开编辑抽屉核对
    await row.locator('[data-testid^="edit-scheduler-"]').click()
    await expect(page.getByTestId("cron-expr")).toHaveValue(stepped)
    await page.getByRole("button", { name: "取消" }).click()

    await page.locator("tbody tr", { hasText: name }).locator('[data-testid^="del-scheduler-"]').click()
    await page.getByTestId("confirm-ok").click()
  })

  test("配错的调度必须当场拦住，不能存进去", async ({ authedPage: page }) => {
    /**
     * 🔴 配错的调度和配错的筛选条件不一样 —— 它会**自己跑**。
     *
     * 存进去之后 `all_as_schedule` 只能跳过它（否则整个 beat 起不来），
     * 于是界面上那条启用着、实际永远不触发，没有任何地方说明为什么。
     */
    const name = `E2E非法${uniqueCode("S")}`

    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()
    await page.getByTestId("s-name").fill(name)
    await page.getByTestId("s-task").click()
    await page.getByRole("option", { name: "maintenance.prune_logs" }).click()

    // 段数不对
    await page.getByTestId("cron-expr").fill("* * *")
    await page.getByTestId("s-submit").click()
    await expect(page.getByText("Crontab 必须是 5 段（分 时 日 月 周）")).toBeVisible()

    // kwargs 不是 JSON 对象
    await page.getByTestId("cron-expr").fill("15 3 * * *")
    await page.getByTestId("s-kwargs").fill("[1, 2]")
    await page.getByTestId("s-submit").click()
    await expect(page.getByText('参数必须是 JSON 对象，例如 {"days": 30}')).toBeVisible()

    // 到这里为止一条都不该存进去
    await page.getByRole("button", { name: "取消" }).click()
    await expect(page.locator("tbody tr", { hasText: name })).toHaveCount(0)
  })

  test("重名要给出可见的业务错误，不能是数据库层面的 500", async ({ authedPage: page, api }) => {
    const name = `E2E重名${uniqueCode("S")}`
    const created = (await api.post(BASE, {
      name, task: "maintenance.prune_logs", type: 1, crontab: "15 3 * * *",
    })) as { id: string }

    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()
    await page.getByTestId("s-name").fill(name)
    await page.getByTestId("s-task").click()
    await page.getByRole("option", { name: "maintenance.prune_logs" }).click()
    await page.getByTestId("s-submit").click()

    await expect(page.getByTestId("s-server-error")).toBeVisible()
    await expect(page.getByTestId("s-server-error")).toContainText("已存在")

    await api.del(BASE, { pks: [created.id] })
  })
})

test.describe("执行记录", () => {
  test("列表带出扩展列，点时间开详情看异常栈", async ({ authedPage: page }) => {
    /**
     * 🔴 `name` / `worker` / `retries` / `queue` 四列只声明在 `TaskExtended` 上，
     * 而它和 `Task` 是**同一张表**。CRUD 绑错的话这四列全是 null ——
     * 接口 200、条数对、时间和状态都对，只有这两列显示 `—`，
     * 看起来像 celery 没写进去。这个 bug 真出现过，是在浏览器里发现的，
     * 当时的接口测试只断言了 `'items' in body`，太弱抓不到。
     */
    await page.goto("/scheduler/record")
    await expect(page.getByTestId("page-title")).toHaveText("执行记录")
    await expect(page.getByTestId("scheduler-record-table")).toBeVisible()

    const first = page.locator('[data-testid^="open-result-"]').first()
    if ((await first.count()) === 0) {
      test.skip(true, "fba_test 里还没有执行记录（需要跑过一次 worker）")
      return
    }

    // 任务名列不能是空的 —— 空了就是 CRUD 绑成了 Task
    const row = page.locator("tbody tr").first()
    await expect(row).not.toContainText(/^\s*$/)

    await first.click()
    await expect(page.getByTestId("result-detail-title")).toBeVisible()
    // 标题就是任务名；绑错时它会是空的
    await expect(page.getByTestId("result-detail-title")).not.toHaveText("")
  })
})

test.describe("cron 预览", () => {
  test("预设 → 表达式 + 人话 + 近五次，且时区标的是服务端的", async ({ authedPage: page, api }) => {
    /**
     * 🔴 「近五次执行时间」是这个控件真正的价值。
     *
     * 配错的调度不会当场报错，只会在某个凌晨该跑没跑 —— 预览是唯一能在
     * **保存前**发现「我以为是每天，其实写成了每分钟」的地方。
     *
     * ⚠️ 时区必须是 **beat 的**（服务端），不是浏览器的。两者不同时，
     * 用浏览器时区算出来的预览看着像模像样、实际差好几个小时 ——
     * 而这个预览存在的全部意义就是让人确认「是不是按我想的时间跑」。
     */
    const meta = (await api.get("/api/v1/tasks/schedulers/meta")) as {
      tasks: string[]
      timezone: string
    }
    expect(meta.timezone).toBeTruthy()

    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()

    // 点「每天早上 8 点」预设
    await page.getByTestId("cron-preset-0_8______").click()
    await expect(page.getByTestId("cron-expr")).toHaveValue("0 8 * * *")

    // 说人话（cronstrue）—— 手写的那版认不出复杂表达式，这里换成了库
    await expect(page.getByTestId("cron-human")).toContainText("08:00")

    // 近五次，且标出服务端时区
    const preview = page.getByTestId("cron-next-runs")
    await expect(preview).toBeVisible()
    await expect(preview).toContainText(meta.timezone)
    await expect(preview.locator("span.font-mono")).toHaveCount(5)

    // 换成「每分钟」，预览必须跟着变（否则它是个静态装饰）
    await page.getByTestId("cron-preset-_________").click()
    await expect(page.getByTestId("cron-expr")).toHaveValue("* * * * *")
    await expect(page.getByTestId("cron-human")).toContainText("每分钟")

    await page.getByRole("button", { name: "取消" }).click()
  })

  test("非法表达式时预览要说不出话，而不是显示上一次的结果", async ({ authedPage: page }) => {
    /**
     * 预览留着旧值比没有预览更糟 —— 用户改成一个错表达式，
     * 下面还稳稳显示着五个时间，看起来像「没问题」。
     */
    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()

    await page.getByTestId("cron-preset-0_8______").click()
    await expect(page.getByTestId("cron-next-runs")).toBeVisible()

    // Quartz 语法：celery 不认（实测 Invalid weekday literal '?'）
    await page.getByTestId("cron-expr").fill("0 0 * * ?")
    await expect(page.getByTestId("cron-human")).toContainText("无法解析")
    await expect(page.getByTestId("cron-next-runs")).toHaveCount(0)

    await page.getByRole("button", { name: "取消" }).click()
  })
})

test.describe("任务参数", () => {
  test("位置参数与关键字参数都能存，且非法 JSON 当场拦住", async ({ authedPage: page }) => {
    /**
     * 后端一直收 `args`，此前界面上**没有入口** —— 「schema 里有、界面上没有」
     * 是这个仓库明确反对的形态：那个字段只有读源码的人知道它存在。
     *
     * 校验必须在写入口拦住：参数错了任务照样被派发，失败发生在 worker 里，
     * 而用户是在界面上填的 —— 中间隔着一次调度周期才看得到红字。
     */
    const name = `E2E参数${uniqueCode("S")}`

    await page.goto("/scheduler/manage")
    await page.getByTestId("add-scheduler").click()
    await page.getByTestId("s-name").fill(name)
    await page.getByTestId("s-task").click()
    await page.getByRole("option", { name: "maintenance.prune_logs" }).click()

    // args 必须是 JSON 数组，不能是对象
    await page.getByTestId("s-args").fill('{"a": 1}')
    await page.getByTestId("s-submit").click()
    await expect(page.getByText('位置参数必须是 JSON 数组，例如 [1, "a"]')).toBeVisible()

    // kwargs 必须是 JSON 对象，不能是数组（两条规则方向相反，容易写反）
    await page.getByTestId("s-args").fill("[]")
    await page.getByTestId("s-kwargs").fill("[1]")
    await page.getByTestId("s-submit").click()
    await expect(page.getByText('参数必须是 JSON 对象，例如 {"days": 30}')).toBeVisible()

    // 都合法就能存，并且**存进去的值要能读回来**（编辑抽屉里核对）
    await page.getByTestId("s-args").fill('[7]')
    await page.getByTestId("s-kwargs").fill('{"days": 60}')
    await page.getByTestId("s-submit").click()

    const row = page.locator("tbody tr", { hasText: name })
    await expect(row).toBeVisible()
    await row.locator('[data-testid^="edit-scheduler-"]').click()
    await expect(page.getByTestId("s-args")).toHaveValue("[7]")
    await expect(page.getByTestId("s-kwargs")).toHaveValue('{"days": 60}')
    await page.getByRole("button", { name: "取消" }).click()

    await page.locator("tbody tr", { hasText: name }).locator('[data-testid^="del-scheduler-"]').click()
    await page.getByTestId("confirm-ok").click()
  })
})

test.describe("执行记录筛选", () => {
  test("时间范围：URL 上是压缩的，发出去的请求补足时分秒", async ({ authedPage: page }) => {
    /**
     * 🔴 URL 参数 ≠ 接口入参，这是两件事：
     *
     *   URL   ?time=2026-08-16~2026-08-22        一个参数、无编码噪音
     *   请求  ?start_time=… 00:00:00&end_time=… 23:59:59
     *
     * **补时分秒那一步不能省。** 后端是 `date_done <= end_time`，
     * 只给日期会被解析成当天 00:00:00，**静默丢掉最后一整天**——
     * 用户选了「到今天」，今天的记录一条都不显示，界面上没有任何异常。
     */
    await page.goto("/scheduler/record")

    const req = page.waitForRequest(
      (r) => r.url().includes("/tasks/results") && r.url().includes("start_time")
    )

    // 直接把区间写进地址栏（等价于在查询区选完点搜索），验的是解码那一段
    await page.goto("/scheduler/record?time=2026-08-16~2026-08-22")
    const url = new URL((await req).url())

    expect(url.searchParams.get("start_time")).toBe("2026-08-16 00:00:00")
    expect(url.searchParams.get("end_time")).toBe("2026-08-22 23:59:59")

    // 地址栏保持压缩形态，不该被展开成两个带编码噪音的参数
    expect(page.url()).toContain("time=2026-08-16~2026-08-22")
    expect(page.url()).not.toContain("start_time")
  })
})
