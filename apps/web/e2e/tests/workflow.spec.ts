import { createApiClient, expect, loginPageAs, test } from "../fixtures/base"

/**
 * 审批流（#107）：发起 → 待办 → 同意（改可编辑字段）→ 通过，全程走界面。
 *
 * 后端的规则（并发、字段权限裁剪、能力信封、幂等）在 pytest 里钉死了
 * （`plugin/workflow/tests/`），这里只验「界面上走得通」+ 那几条只有界面能看见的东西：
 * 按钮是不是按能力信封出的、隐藏字段在审批人那里是不是真的不在 DOM 里、
 * 消息里的链接能不能直接打开详情抽屉。
 *
 * 流程定义每次现建（编码带时间戳）：有过实例的定义删不掉，固定编码会撞唯一约束。
 *
 * 种子组织：孙强（sunqiang）在市场运营中心，部门负责人是赵磊（zhaolei）。
 */
const CODE = `E2EWF_${Date.now().toString(36).toUpperCase()}`

test.describe.configure({ mode: "serial" })

test.beforeAll(async () => {
  const { api, dispose } = await createApiClient()
  const form = {
    schemaVersion: 1,
    fields: [
      { id: "f_reason", type: "text", label: "事由", required: true },
      { id: "f_days", type: "number", label: "天数", required: true },
      { id: "f_note", type: "textarea", label: "主管备注" },
      { id: "f_secret", type: "text", label: "仅发起人可见" },
    ],
  }
  const model = {
    schemaVersion: 1,
    root: {
      type: "start",
      id: "start",
      next: {
        type: "approval",
        id: "n_leader",
        name: "直属主管",
        mode: "any",
        assignee: { kind: "dept_leader", level: 1 },
        onEmpty: "reject",
        fieldPerms: { f_note: "editable", f_secret: "hidden" },
        next: null,
      },
    },
  }
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code: CODE,
    name: `E2E 请示 ${CODE}`,
    category: "E2E",
    form,
    model,
  })) as { id: string }
  const res = (await api.post(`/api/v1/sys/workflow/definitions/${created.id}/publish`)) as { published: boolean }
  expect(res.published).toBe(true)
  await dispose()
})

test("发起 → 主管在待办里同意并填备注 → 发起人看到已通过", async ({ browser }) => {
  // ── 发起人 ──
  const initiator = await browser.newPage()
  await loginPageAs(initiator, "sunqiang", "123456")
  await initiator.goto("/workflow/inbox")
  const scopeA = initiator.locator('[data-tab="/_auth/workflow/inbox"]')
  await scopeA.getByTestId("wf-start-menu").click()
  await initiator.getByTestId("wf-template-search").fill(CODE)
  await initiator.getByTestId(`wf-start-${CODE}`).click()

  const sheet = initiator.getByTestId("wf-start-sheet")
  await expect(sheet.getByTestId("wf-start-title")).toHaveText(`E2E 请示 ${CODE}`)
  // 必填没填：当场拦住，不发请求
  await sheet.getByTestId("wf-start-submit").click()
  await expect(sheet.getByText("请填写「事由」")).toBeVisible()

  await sheet.getByTestId("wf-field-f_reason").locator("input").fill("年底盘点")
  await sheet.getByTestId("wf-field-f_days").locator("input").fill("2")
  await sheet.getByTestId("wf-field-f_secret").locator("input").fill("只有我能看")
  // 右边的审批流程预告：发起人在市场运营中心 → 直属主管是赵磊
  await expect(sheet.getByTestId("wf-start-track")).toContainText("赵磊")
  await sheet.getByTestId("wf-start-submit").click()

  // 提交后：抽屉换成详情，URL 带上 id（刷新还在，硬纪律 2）
  const detail = initiator.getByTestId("wf-instance-sheet")
  await expect(detail.getByTestId("wf-status")).toHaveText("审批中")
  await expect(initiator).toHaveURL(/[?&]id=\d+/)
  const id = new URL(initiator.url()).searchParams.get("id")
  expect(id).toBeTruthy()
  // 发起人：只有撤回 / 催办，没有同意 / 驳回（按能力信封出，不是前端推的）
  await expect(detail.getByTestId("wf-act-withdraw")).toBeVisible()
  await expect(detail.getByTestId("wf-act-remind")).toBeVisible()
  await expect(detail.getByTestId("wf-act-approve")).toHaveCount(0)
  await expect(detail.getByTestId("wf-field-f_secret")).toBeVisible()

  // ── 审批人 ──
  const approver = await browser.newPage()
  await loginPageAs(approver, "zhaolei", "123456")
  await approver.goto("/workflow/inbox")
  const scopeB = approver.locator('[data-tab="/_auth/workflow/inbox"]')
  await expect(scopeB.getByTestId(`wf-row-${id}`)).toBeVisible()
  await expect(scopeB.getByTestId("wf-badge-todo")).toBeVisible()
  await scopeB.getByTestId(`wf-row-${id}`).click()

  const sheetB = approver.getByTestId("wf-instance-sheet")
  await expect(sheetB.getByTestId("wf-act-approve")).toBeVisible()
  // 隐藏字段：服务端裁掉了，DOM 里根本没有 —— 不是藏起来
  await expect(sheetB.getByTestId("wf-field-f_reason")).toBeVisible()
  await expect(sheetB.getByTestId("wf-field-f_secret")).toHaveCount(0)
  // 可编辑字段在审批人这里是输入框，只读字段不是
  await expect(sheetB.getByTestId("wf-field-f_note")).toHaveAttribute("data-editable", "true")
  await expect(sheetB.getByTestId("wf-field-f_reason")).toHaveAttribute("data-editable", "false")

  await sheetB.getByTestId("wf-field-f_note").locator("textarea").fill("同意，注意交接")
  // 意见框就在底部，不弹窗；驳回不写意见会被当场拦住
  await sheetB.getByTestId("wf-act-reject").click()
  await expect(sheetB.getByText("驳回时请写明原因")).toBeVisible()
  await sheetB.getByTestId("wf-action-opinion").fill("可以")
  await sheetB.getByTestId("wf-act-approve").click()
  // 审批人办完抽屉关掉，待办里没了
  await expect(sheetB).toBeHidden()
  await expect(scopeB.getByTestId(`wf-row-${id}`)).toHaveCount(0)

  // ── 回到发起人：已通过，备注在，审批记录里有那条意见 ──
  await initiator.reload()
  const detailA = initiator.getByTestId("wf-instance-sheet")
  await expect(detailA.getByTestId("wf-status")).toHaveText("已通过")
  await expect(detailA.getByTestId("wf-field-f_note")).toContainText("同意，注意交接")
  await expect(detailA.getByTestId("wf-timeline")).toContainText("可以")
  await expect(detailA.getByTestId("wf-actions")).toHaveCount(0)

  // 消息中心里的结果通知能点，点进去就是这张单（link 带 `?id=`，曾经整条变成不可点）
  await initiator.goto("/notification")
  const scopeN = initiator.locator('[data-tab="/_auth/notification"]')
  const link = scopeN.locator(`[data-testid^="open-notification-"]`, { hasText: "已通过" }).first()
  await expect(link).toBeVisible()
  await link.click()
  const reopened = initiator.getByTestId("wf-instance-sheet")
  await expect(reopened.getByTestId("wf-title")).toBeVisible()
  await expect(initiator).toHaveURL(new RegExp(`/workflow/inbox\\?id=${id}`))
  await expect(reopened.getByTestId("wf-status")).toHaveText("已通过")
  const detailA2 = reopened

  // 流程图：节点标成已办
  await detailA2.getByTestId("wf-tab-flow").click()
  await expect(detailA2.getByTestId("flow-node-n_leader")).toHaveAttribute("data-state", "done")

  await initiator.close()
  await approver.close()
})

test("设计器：打开定义、选中节点出属性面板、发布校验能定位到节点", async ({ page }) => {
  await loginPageAs(page, "admin", "123456")
  await page.goto("/workflow/definition")
  const scope = page.locator('[data-tab="/_auth/workflow/definition"]')
  await scope.getByTestId(`wfd-open-${CODE}`).click()
  await expect(scope.getByTestId("wfd-designer")).toBeVisible()

  // 表单设计：加一个控件 → 有未保存的修改
  await scope.getByTestId("fd-add-amount").click()
  await expect(scope.getByTestId("wfd-dirty")).toBeVisible()
  await expect(scope.getByTestId("fd-prop-label")).toHaveValue("金额")

  // 流程设计：在开始后面插一个审批节点但不配审批人 → 发布被拒、问题定位到那个节点
  await scope.getByTestId("wfd-step-flow").click()
  // 点「发起人」出发起人的字段权限（默认可编辑）
  await scope.getByTestId("flow-start").click()
  await expect(scope.getByTestId("start-props")).toBeVisible()
  await expect(scope.getByTestId("start-perm-f_reason-editable")).toHaveClass(/border-primary/)
  await scope.getByTestId("flow-add-after-start").click()
  await page.getByTestId("flow-add-approval").click()
  await expect(scope.getByTestId("node-name")).toHaveValue("审批人")
  // 新节点还没选审批人规则（画布上也是红字「未设置审批人」）
  await scope.getByTestId("wfd-publish").click()
  await expect(scope.getByTestId("wfd-issues")).toContainText("APPROVER_EMPTY")
  // 保存成功了（草稿），未保存提示消失
  await expect(scope.getByTestId("wfd-dirty")).toHaveCount(0)
})

test("附件上传 / 下载 + 驳回后重新发起（带着原来的内容）", async ({ browser }) => {
  const code = `${CODE}F`
  const { api, dispose } = await createApiClient()
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code,
    name: `E2E 附件 ${code}`,
    category: "E2E",
    form: {
      schemaVersion: 1,
      fields: [
        { id: "f_what", type: "text", label: "事项", required: true },
        { id: "f_files", type: "attachment", label: "附件", required: true },
      ],
    },
    model: {
      schemaVersion: 1,
      root: {
        type: "start",
        id: "start",
        next: {
          type: "approval", id: "n1", name: "直属主管", mode: "any",
          assignee: { kind: "dept_leader", level: 1 }, onEmpty: "reject", next: null,
        },
      },
    },
  })) as { id: string }
  await api.post(`/api/v1/sys/workflow/definitions/${created.id}/publish`)
  await dispose()

  const a = await browser.newPage()
  await loginPageAs(a, "sunqiang", "123456")
  await a.goto(`/workflow/inbox?start=${code}`)
  const sheet = a.getByTestId("wf-start-sheet")
  await sheet.getByTestId("wf-field-f_what").locator("input").fill("报销打车费")
  // 普通员工也能传（走审批自己的上传口，不要 sys:file:upload）
  await sheet.getByTestId("wf-files-f_files-input").setInputFiles({
    name: "车票.txt", mimeType: "text/plain", buffer: Buffer.from("taxi 42.00"),
  })
  await expect(sheet.getByTestId("wf-files-f_files")).toContainText("车票.txt")
  await sheet.getByTestId("wf-start-submit").click()
  const detail = a.getByTestId("wf-instance-sheet")
  await expect(detail.getByTestId("wf-status")).toHaveText("审批中")
  const id = new URL(a.url()).searchParams.get("id")

  // 审批人看得到附件名，驳回
  const b = await browser.newPage()
  await loginPageAs(b, "zhaolei", "123456")
  await b.goto(`/workflow/inbox?id=${id}`)
  const sheetB = b.getByTestId("wf-instance-sheet")
  await expect(sheetB.getByTestId("wf-field-f_files")).toContainText("车票.txt")
  // 下载：带鉴权取字节再存，文件名是原名、内容一字不差（裸 <a href> 会存下 401 的 JSON）
  const [dl] = await Promise.all([
    b.waitForEvent("download"),
    sheetB.getByTestId("wf-field-f_files").getByRole("button", { name: "车票.txt" }).click(),
  ])
  expect(dl.suggestedFilename()).toBe("车票.txt")
  const chunks: Buffer[] = []
  for await (const c of (await dl.createReadStream())!) chunks.push(c as Buffer)
  expect(Buffer.concat(chunks).toString()).toBe("taxi 42.00")
  await sheetB.getByTestId("wf-action-opinion").fill("缺发票")
  await sheetB.getByTestId("wf-act-reject").click()
  await expect(sheetB).toBeHidden()

  // 发起人：已驳回 → 重新发起，原来的内容带过来（附件也在），提交成一张新单
  await a.reload()
  const again = a.getByTestId("wf-instance-sheet")
  await expect(again.getByTestId("wf-status")).toHaveText("已驳回")
  await again.getByTestId("wf-resubmit").click()
  const sheet2 = a.getByTestId("wf-start-sheet")
  await expect(sheet2.getByTestId("wf-field-f_what").locator("input")).toHaveValue("报销打车费")
  await expect(sheet2.getByTestId("wf-files-f_files")).toContainText("车票.txt")
  await sheet2.getByTestId("wf-start-submit").click()
  await expect(a.getByTestId("wf-instance-sheet").getByTestId("wf-status")).toHaveText("审批中")
  const id2 = new URL(a.url()).searchParams.get("id")
  expect(id2).toBeTruthy()
  expect(id2).not.toBe(id)

  await a.close()
  await b.close()
})

test("填到一半切走再切回来：草稿还在；后台的抽屉不挡前台页面", async ({ page }) => {
  await loginPageAs(page, "sunqiang", "123456")
  await page.goto(`/workflow/inbox?start=${CODE}`)
  const sheet = page.getByTestId("wf-start-sheet")
  await sheet.getByTestId("wf-field-f_reason").locator("input").fill("填了一半的事由")

  // 应用内切到消息中心（不是 goto —— 整页刷新本来就会丢掉所有内存状态）。
  // 抽屉开着时外面是 inert 的，先按 Esc 之外的方式离开：直接改地址栏走路由
  // 字符串形式：e2e 的 tsconfig 不带 DOM 类型
  await page.evaluate('history.pushState({}, "", "/notification"); dispatchEvent(new PopStateEvent("popstate"))')
  const front = page.locator('[data-tab="/_auth/notification"]')
  await expect(front).toHaveAttribute("data-visible", "true")
  // 后台那个抽屉跟着 tab 一起藏起来，不压在前台上（曾经挡住所有点击）
  await expect(sheet).toBeHidden()
  await front.getByTestId("page-title").waitFor({ state: "attached" })
  await page.getByTestId("tab-/_auth/workflow/inbox").click()

  // 切回来：抽屉还开着，填的内容还在（曾经为了不挡前台把整个抽屉卸载，草稿跟着没了）
  await expect(sheet).toBeVisible()
  await expect(sheet.getByTestId("wf-field-f_reason").locator("input")).toHaveValue("填了一半的事由")
})

test("退回给发起人 → 发起人改好重新提交 → 回到主管手上", async ({ browser }) => {
  const a = await browser.newPage()
  await loginPageAs(a, "sunqiang", "123456")
  await a.goto(`/workflow/inbox?start=${CODE}`)
  const start = a.getByTestId("wf-start-sheet")
  await start.getByTestId("wf-field-f_reason").locator("input").fill("第一版事由")
  await start.getByTestId("wf-field-f_days").locator("input").fill("1")
  await start.getByTestId("wf-start-submit").click()
  await expect(a.getByTestId("wf-instance-sheet").getByTestId("wf-status")).toHaveText("审批中")
  const id = new URL(a.url()).searchParams.get("id")

  // 主管退回：选「发起人」、写原因
  const b = await browser.newPage()
  await loginPageAs(b, "zhaolei", "123456")
  await b.goto(`/workflow/inbox?id=${id}`)
  const sheetB = b.getByTestId("wf-instance-sheet")
  await sheetB.getByTestId("wf-act-send_back").click()
  const dialog = b.getByTestId("wf-action-dialog")
  await expect(dialog.getByTestId("wf-back-start")).toBeVisible()
  // 没写原因提交不了
  await expect(dialog.getByTestId("wf-action-submit")).toBeDisabled()
  await dialog.getByTestId("wf-back-start").click()
  await dialog.getByTestId("wf-dialog-opinion").fill("事由写具体一点")
  await dialog.getByTestId("wf-action-submit").click()
  await expect(sheetB).toBeHidden()

  // 发起人：单还在审批中，顶上写着谁退回、为什么；字段能改，按钮是「重新提交」，没有「驳回」
  await a.reload()
  const sheetA = a.getByTestId("wf-instance-sheet")
  await expect(sheetA.getByTestId("wf-sent-back")).toContainText("事由写具体一点")
  await expect(sheetA.getByTestId("wf-status")).toHaveText("审批中")
  await expect(sheetA.getByTestId("wf-act-approve")).toHaveText("重新提交")
  await expect(sheetA.getByTestId("wf-act-reject")).toHaveCount(0)
  await expect(sheetA.getByTestId("wf-field-f_reason")).toHaveAttribute("data-editable", "true")
  await sheetA.getByTestId("wf-field-f_reason").locator("input").fill("第二版：年底盘点三天")
  await sheetA.getByTestId("wf-act-approve").click()
  await expect(sheetA).toBeHidden()

  // 又回到主管手上，看到的是改过的内容；进度里两轮各占一步
  await b.goto(`/workflow/inbox?id=${id}`)
  const again = b.getByTestId("wf-instance-sheet")
  await expect(again.getByTestId("wf-field-f_reason")).toContainText("第二版：年底盘点三天")
  await expect(again.getByTestId("wf-act-approve")).toBeVisible()
  await expect(again.getByTestId("wf-timeline")).toContainText("退回给 发起人")
  await expect(again.getByTestId("wf-timeline")).toContainText("已重新提交")
  await a.close()
  await b.close()
})

test("表单联动：按条件显示的字段、明细表合计（界面当场算，服务端存的是它自己算的）", async ({ browser }) => {
  const code = `${CODE}R`
  const { api, dispose } = await createApiClient()
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code,
    name: `E2E 联动 ${code}`,
    category: "E2E",
    form: {
      schemaVersion: 1,
      fields: [
        { id: "f_n", type: "number", label: "人数", required: true },
        {
          id: "f_why", type: "text", label: "超员说明", required: true,
          visibleWhen: { all: [{ var: "f_n", op: "gt", value: 3 }] },
        },
        { id: "f_items", type: "table", label: "费用明细", columns: [{ id: "amt", type: "amount", label: "金额" }] },
        { id: "f_total", type: "amount", label: "合计", calc: { kind: "sum", field: "f_items", column: "amt" } },
      ],
    },
    model: {
      schemaVersion: 1,
      root: {
        type: "start", id: "start",
        next: {
          type: "approval", id: "n1", name: "直属主管", mode: "any",
          assignee: { kind: "dept_leader", level: 1 }, onEmpty: "reject", next: null,
        },
      },
    },
  })) as { id: string }
  const pub = (await api.post(`/api/v1/sys/workflow/definitions/${created.id}/publish`)) as { published: boolean }
  expect(pub.published).toBe(true)
  await dispose()

  const page = await browser.newPage()
  await loginPageAs(page, "sunqiang", "123456")
  await page.goto(`/workflow/inbox?start=${code}`)
  const sheet = page.getByTestId("wf-start-sheet")
  await sheet.getByTestId("wf-field-f_n").locator("input").fill("2")
  // 先断言「有」：人数字段在，再断言超员说明不在
  await expect(sheet.getByTestId("wf-field-f_n")).toBeVisible()
  await expect(sheet.getByTestId("wf-field-f_why")).toHaveCount(0)
  await sheet.getByTestId("wf-field-f_n").locator("input").fill("5")
  await expect(sheet.getByTestId("wf-field-f_why")).toBeVisible()

  // 明细两行，合计当场算（0.10 + 0.20 不能变成 0.30000000000000004）
  const items = sheet.getByTestId("wf-field-f_items")
  await items.getByRole("button", { name: "添加一行" }).click()
  await items.getByRole("button", { name: "添加一行" }).click()
  const inputs = items.locator("input")
  await inputs.nth(0).fill("0.10")
  await inputs.nth(1).fill("0.20")
  await expect(sheet.getByTestId("wf-field-f_total")).toContainText("0.30")
  await expect(sheet.getByTestId("wf-field-f_total")).toContainText("自动计算")

  // 超员说明是必填的：显示出来了就得填
  await sheet.getByTestId("wf-start-submit").click()
  await expect(sheet.getByText("请填写「超员说明」")).toBeVisible()
  await sheet.getByTestId("wf-field-f_why").locator("input").fill("客户来访")
  await sheet.getByTestId("wf-start-submit").click()
  const detail = page.getByTestId("wf-instance-sheet")
  await expect(detail.getByTestId("wf-status")).toHaveText("审批中")
  await expect(detail.getByTestId("wf-field-f_total")).toContainText("0.30")
  await expect(detail.getByTestId("wf-field-f_why")).toContainText("客户来访")
  await page.close()
})

test("管理员改办理人：卡住的待办交给别人", async ({ browser }) => {
  const a = await browser.newPage()
  await loginPageAs(a, "sunqiang", "123456")
  await a.goto(`/workflow/inbox?start=${CODE}`)
  const start = a.getByTestId("wf-start-sheet")
  await start.getByTestId("wf-field-f_reason").locator("input").fill("请人代审")
  await start.getByTestId("wf-field-f_days").locator("input").fill("1")
  await start.getByTestId("wf-start-submit").click()
  await expect(a.getByTestId("wf-instance-sheet").getByTestId("wf-status")).toHaveText("审批中")
  const id = new URL(a.url()).searchParams.get("id")
  await a.close()

  const admin = await browser.newPage()
  await loginPageAs(admin, "admin", "123456")
  await admin.goto(`/workflow/monitor?id=${id}`)
  const sheet = admin.getByTestId("wf-instance-sheet")
  await sheet.getByTestId("wf-act-reassign").click()
  const dialog = admin.getByTestId("wf-action-dialog")
  await expect(dialog).toContainText("当前办理人：赵磊")
  await dialog.getByTestId("wf-action-users").click()
  await admin.getByTestId("wf-action-users-search").fill("wangfang")
  await admin.getByTestId("wf-action-users-search").press("Enter")
  await admin.getByTestId("wf-action-users-opt-wangfang").click()
  // 单选：选完浮层自己关。别按 Esc —— 那会连弹窗一起关掉
  await expect(dialog.getByTestId("wf-action-users")).toContainText("王芳")
  await dialog.getByTestId("wf-action-submit").click()
  await expect(dialog).toBeHidden()
  await expect(sheet.getByTestId("wf-timeline")).toContainText("管理员改给 王芳")

  // 王芳的待办里有了
  const w = await browser.newPage()
  await loginPageAs(w, "wangfang", "123456")
  await w.goto("/workflow/inbox")
  await expect(w.locator('[data-tab="/_auth/workflow/inbox"]').getByTestId(`wf-row-${id}`)).toBeVisible()
  await admin.close()
  await w.close()
})

/** 两步的流程：直属主管（赵磊）→ 王芳。退回直达 / 拿回要有「下一步」 */
async function twoStepFlow(code: string): Promise<void> {
  const { api, dispose } = await createApiClient()
  const users = (await api.get("/api/v1/sys/workflow/directory/users?keyword=wangfang")) as { id: string }[]
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code,
    name: `E2E 两步 ${code}`,
    category: "E2E",
    form: { schemaVersion: 1, fields: [{ id: "f_reason", type: "text", label: "事由", required: true }] },
    model: {
      schemaVersion: 1,
      root: {
        type: "start", id: "start",
        next: {
          type: "approval", id: "n1", name: "直属主管", mode: "any",
          assignee: { kind: "dept_leader", level: 1 }, onEmpty: "reject",
          next: {
            type: "approval", id: "n2", name: "复核", mode: "any",
            assignee: { kind: "user", user_ids: [users[0].id] }, onEmpty: "reject", next: null,
          },
        },
      },
    },
  })) as { id: string }
  const pub = (await api.post(`/api/v1/sys/workflow/definitions/${created.id}/publish`)) as { published: boolean }
  expect(pub.published).toBe(true)
  await dispose()
}

async function startAs(browser: import("@playwright/test").Browser, code: string, reason: string) {
  const a = await browser.newPage()
  await loginPageAs(a, "sunqiang", "123456")
  await a.goto(`/workflow/inbox?start=${code}`)
  const sheet = a.getByTestId("wf-start-sheet")
  await sheet.getByTestId("wf-field-f_reason").locator("input").fill(reason)
  await sheet.getByTestId("wf-start-submit").click()
  await expect(a.getByTestId("wf-instance-sheet").getByTestId("wf-status")).toHaveText("审批中")
  return { page: a, id: new URL(a.url()).searchParams.get("id") as string }
}

test("拿回：同意之后、下一个人还没动之前，把单收回来", async ({ browser }) => {
  const code = `${CODE}T`
  await twoStepFlow(code)
  const { page: a, id } = await startAs(browser, code, "点错了同意")
  await a.close()

  const z = await browser.newPage()
  await loginPageAs(z, "zhaolei", "123456")
  await z.goto(`/workflow/inbox?id=${id}`)
  const sheet = z.getByTestId("wf-instance-sheet")
  await expect(sheet.getByTestId("wf-act-take_back")).toHaveCount(0)
  await sheet.getByTestId("wf-act-approve").click()
  await expect(sheet).toBeHidden()
  // 从「我已审批」里重新打开：多了「拿回」
  await z.goto(`/workflow/inbox?id=${id}`)
  await sheet.getByTestId("wf-act-take_back").click()
  await expect(sheet.getByTestId("wf-act-approve")).toBeVisible()
  await expect(sheet.getByTestId("wf-timeline")).toContainText("已拿回")
  await z.close()
})

test("加签（在我之前）：先请陈静审，她同意后回到主管", async ({ browser }) => {
  const code = `${CODE}S`
  await twoStepFlow(code)
  const { page: a, id } = await startAs(browser, code, "请财务也看看")
  await a.close()

  const z = await browser.newPage()
  await loginPageAs(z, "zhaolei", "123456")
  await z.goto(`/workflow/inbox?id=${id}`)
  const sheet = z.getByTestId("wf-instance-sheet")
  await sheet.getByTestId("wf-act-add_sign").click()
  const dialog = z.getByTestId("wf-action-dialog")
  await expect(dialog.getByTestId("wf-sign-before")).toBeVisible()
  await dialog.getByTestId("wf-action-users").click()
  await z.getByTestId("wf-action-users-search").fill("chenjing")
  await z.getByTestId("wf-action-users-search").press("Enter")
  await z.getByTestId("wf-action-users-opt-chenjing").click()
  // 多选：浮层不会自己关，点弹窗标题收起来（别按 Esc —— 会连弹窗一起关）
  await dialog.getByRole("heading").click()
  await dialog.getByTestId("wf-action-submit").click()
  await expect(sheet).toBeHidden()

  const w = await browser.newPage()
  await loginPageAs(w, "chenjing", "123456")
  await w.goto(`/workflow/inbox?id=${id}`)
  const sheetW = w.getByTestId("wf-instance-sheet")
  // 加签进来的人只表态：有同意，没有加签 / 退回
  await expect(sheetW.getByTestId("wf-act-approve")).toBeVisible()
  await expect(sheetW.getByTestId("wf-act-add_sign")).toHaveCount(0)
  await expect(sheetW.getByTestId("wf-act-send_back")).toHaveCount(0)
  await sheetW.getByTestId("wf-act-approve").click()
  await expect(sheetW).toBeHidden()

  await z.goto(`/workflow/inbox?id=${id}`)
  await expect(sheet.getByTestId("wf-act-approve")).toBeVisible()
  await expect(sheet.getByTestId("wf-timeline")).toContainText("加签给 陈静")
  await z.close()
  await w.close()
})

test("退回时选「直接回到我这一步」：发起人重新提交后跳过主管，直接到复核", async ({ browser }) => {
  const code = `${CODE}B`
  await twoStepFlow(code)
  const { page: a, id } = await startAs(browser, code, "第一版")

  const z = await browser.newPage()
  await loginPageAs(z, "zhaolei", "123456")
  await z.goto(`/workflow/inbox?id=${id}`)
  await z.getByTestId("wf-instance-sheet").getByTestId("wf-act-approve").click()
  await z.close()

  const w = await browser.newPage()
  await loginPageAs(w, "wangfang", "123456")
  await w.goto(`/workflow/inbox?id=${id}`)
  const sheetW = w.getByTestId("wf-instance-sheet")
  await sheetW.getByTestId("wf-act-send_back").click()
  const dialog = w.getByTestId("wf-action-dialog")
  await dialog.getByTestId("wf-back-start").click()
  await dialog.getByTestId("wf-back-resume-me").click()
  await dialog.getByTestId("wf-dialog-opinion").fill("补充一下")
  await dialog.getByTestId("wf-action-submit").click()
  await expect(sheetW).toBeHidden()

  // 发起人：预告里下一步直接是「复核」，不是「直属主管」
  await a.goto(`/workflow/inbox?id=${id}`)
  const sheetA = a.getByTestId("wf-instance-sheet")
  await expect(sheetA.getByTestId("wf-sent-back")).toBeVisible()
  await sheetA.getByTestId("wf-field-f_reason").locator("input").fill("第二版")
  await sheetA.getByTestId("wf-act-approve").click()
  await expect(sheetA).toBeHidden()

  await w.goto(`/workflow/inbox?id=${id}`)
  await expect(sheetW.getByTestId("wf-act-approve")).toBeVisible()
  await expect(sheetW.getByTestId("wf-timeline")).toContainText("直接回到「复核」")
  await a.close()
  await w.close()
})

test("草稿：关掉再打开内容还在；加急排在审批人列表里；审批人打开后发起人看到「已读」", async ({ browser }) => {
  const code = `${CODE}D`
  await twoStepFlow(code)
  const a = await browser.newPage()
  await loginPageAs(a, "sunqiang", "123456")
  await a.goto(`/workflow/inbox?start=${code}`)
  const sheet = a.getByTestId("wf-start-sheet")
  await sheet.getByTestId("wf-field-f_reason").locator("input").fill("写到一半")
  await expect(sheet.getByTestId("wf-draft-status")).toContainText("草稿已保存")
  // 关掉抽屉、整页刷新再打开：内容从服务端的草稿恢复
  await a.goto("/workflow/inbox")
  await a.goto(`/workflow/inbox?start=${code}`)
  await expect(sheet.getByTestId("wf-draft-restored")).toBeVisible()
  await expect(sheet.getByTestId("wf-field-f_reason").locator("input")).toHaveValue("写到一半")

  // 标加急提交
  await sheet.getByTestId("wf-start-urgent").click()
  await sheet.getByTestId("wf-start-submit").click()
  const detail = a.getByTestId("wf-instance-sheet")
  await expect(detail.getByTestId("wf-urgent")).toBeVisible()
  const id = new URL(a.url()).searchParams.get("id") as string
  // 提交之后草稿没了：再打开是空的
  await a.goto(`/workflow/inbox?start=${code}`)
  await expect(sheet.getByTestId("wf-start-title")).toBeVisible()
  await expect(sheet.getByTestId("wf-draft-restored")).toHaveCount(0)
  await expect(sheet.getByTestId("wf-field-f_reason").locator("input")).toHaveValue("")

  // 审批人：列表里带加急；打开 = 已读
  const z = await browser.newPage()
  await loginPageAs(z, "zhaolei", "123456")
  await z.goto("/workflow/inbox")
  const row = z.locator('[data-tab="/_auth/workflow/inbox"]').getByTestId(`wf-row-${id}`)
  await expect(row.getByTestId("wf-urgent")).toBeVisible()
  // 先断言「有」：打开之前发起人看到的是未读
  await a.goto(`/workflow/inbox?id=${id}`)
  await expect(detail.getByTestId("wf-timeline")).toContainText("未读")
  await row.click()
  await expect(z.getByTestId("wf-instance-sheet").getByTestId("wf-act-approve")).toBeVisible()
  await expect.poll(async () => {
    await a.reload()
    return detail.getByTestId("wf-timeline").innerText()
  }).toContain("已读")
  await a.close()
  await z.close()
})

test("附件上传期间在别的字段里打的字，传完不会被盖回去", async ({ browser }) => {
  const code = `${CODE}F`  // 「附件」那条建的流程：事项 + 附件
  const a = await browser.newPage()
  await loginPageAs(a, "sunqiang", "123456")
  // 让上传慢 1.5 秒：上传期间改别的字段（原来传完回调用的是开始上传那一刻的表单，把这段改动盖掉）
  await a.route(/\/sys\/workflow\/files$/, async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.continue()
  })
  await a.goto(`/workflow/inbox?start=${code}`)
  const sheet = a.getByTestId("wf-start-sheet")
  await sheet.getByTestId("wf-field-f_what").locator("input").fill("上传前")
  await sheet.getByTestId("wf-files-f_files-input").setInputFiles({
    name: `慢.txt`, mimeType: "text/plain", buffer: Buffer.from(`slow ${Date.now()}`),
  })
  await sheet.getByTestId("wf-field-f_what").locator("input").fill("上传期间改的")
  await expect(sheet.getByTestId("wf-files-f_files")).toContainText("慢.txt")
  await expect(sheet.getByTestId("wf-field-f_what").locator("input")).toHaveValue("上传期间改的")
  await a.close()
})

test("设计器：在表单这一步点流程节点的发布问题，跳到流程设计并选中那个节点", async ({ page }) => {
  await loginPageAs(page, "admin", "123456")
  await page.goto("/workflow/definition")
  const scope = page.locator('[data-tab="/_auth/workflow/definition"]')
  await scope.getByTestId(`wfd-open-${CODE}`).click()
  await scope.getByTestId("wfd-step-flow").click()
  await scope.getByTestId("flow-add-after-start").click()
  await page.getByTestId("flow-add-approval").click()
  await scope.getByTestId("wfd-publish").click()
  await expect(scope.getByTestId("wfd-issues")).toContainText("APPROVER_EMPTY")
  // 回到表单这一步，再点那条问题（原来连着改 step 和 sel，第二次把 step 写回 form，看起来点了没反应）
  await scope.getByTestId("wfd-step-form").click()
  await expect(page).toHaveURL(/step=form/)
  await scope.getByTestId("wfd-issues").getByRole("button", { name: /APPROVER_EMPTY/ }).first().click()
  await expect(page).toHaveURL(/step=flow/)
  await expect(scope.getByTestId("node-name")).toBeVisible()
})

test("实例监控：和列表页同一套查询区；按发起人筛、刷新还在；点标题开详情", async ({ page }) => {
  await loginPageAs(page, "admin", "123456")
  await page.goto("/workflow/monitor")
  const scope = page.locator('[data-tab="/_auth/workflow/monitor"]')
  // 先断言「有」：表格里有行
  await expect(scope.locator('[data-testid^="wf-monitor-row-"]').first()).toBeVisible()
  await scope.getByTestId("qb-input-initiator").fill("孙强")
  await scope.getByTestId("qb-search").click()
  await expect(page).toHaveURL(/initiator=/)
  const rows = scope.locator('[data-testid^="wf-monitor-row-"]')
  await expect(rows.first()).toBeVisible()
  // 每一行的发起人都是孙强
  for (const text of await rows.allInnerTexts()) expect(text).toContain("孙强")
  // 视图状态进 URL：刷新之后条件还在
  await page.reload()
  await expect(scope.getByTestId("qb-input-initiator")).toHaveValue("孙强")
  // 点标题开详情
  await rows.first().locator('[data-testid^="wf-monitor-open-"]').click()
  await expect(page.getByTestId("wf-instance-sheet").getByTestId("wf-title")).toBeVisible()
  await expect(page).toHaveURL(/[?&]id=\d+/)
})
