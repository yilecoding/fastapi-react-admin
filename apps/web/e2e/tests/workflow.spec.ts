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
  await initiator.getByTestId(`wf-start-${CODE}`).click()

  const sheet = initiator.getByTestId("wf-start-sheet")
  await expect(sheet.getByTestId("wf-start-title")).toHaveText(`E2E 请示 ${CODE}`)
  // 必填没填：当场拦住，不发请求
  await sheet.getByTestId("wf-start-submit").click()
  await expect(sheet.getByText("请填写「事由」")).toBeVisible()

  await sheet.getByTestId("wf-field-f_reason").locator("input").fill("年底盘点")
  await sheet.getByTestId("wf-field-f_days").locator("input").fill("2")
  await sheet.getByTestId("wf-field-f_secret").locator("input").fill("只有我能看")
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
  await sheetB.getByTestId("wf-act-approve").click()
  await approver.getByTestId("wf-action-opinion").fill("可以")
  await approver.getByTestId("wf-action-submit").click()
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

  // 流程图：节点标成已办
  await detailA.getByTestId("wf-tab-flow").click()
  await expect(detailA.getByTestId("flow-node-n_leader")).toHaveAttribute("data-state", "done")

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
