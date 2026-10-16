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
