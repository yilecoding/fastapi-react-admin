import { request } from "@playwright/test"

import { API_BASE, createApiClient, expect, loginPageAs, loginToken, test } from "../fixtures/base"

/**
 * 审批前端「旧状态」三件事（#403），都只能在真页面上看出来：
 *
 * 1. 会签：后同意的人只改了备注，提交的却是**打开详情那一刻**整份可编辑字段的快照，把先同意的人改的金额静默改回去
 * 2. 详情抽屉换单不重挂：A 单写了一半的意见，切到（缓存里有的）B 单还在，点同意就提交给了 B
 * 3. 发起草稿：最后一个字段填完 1.5 秒内点「取消」，那次防抖保存被丢掉，重开是旧的 / 空的
 *
 * 种子组织：孙强（sunqiang）发起，赵磊（zhaolei）是他的部门负责人，王芳（wangfang）是另一个审批人。
 */
const CODE = `E2EWS_${Date.now().toString(36).toUpperCase()}`

test.beforeEach(() => test.slow())

/** 以某个账号直接打审批接口（造前置数据 / 模拟「另一个人先办了」） */
async function as(username: string) {
  const ctx = await request.newContext({ baseURL: API_BASE })
  const { token } = await loginToken(ctx, username)
  const headers = { Authorization: `Bearer ${token}` }
  async function post(path: string, data: unknown): Promise<Record<string, unknown>> {
    const res = await ctx.post(`${API_BASE}/api/v1${path}`, { headers, data })
    const body = (await res.json()) as { code: number; data: Record<string, unknown>; msg: string }
    if (body.code !== 200) throw new Error(`${path}：${body.msg}`)
    return body.data
  }
  async function get(path: string): Promise<Record<string, unknown>> {
    const res = await ctx.get(`${API_BASE}/api/v1${path}`, { headers })
    return ((await res.json()) as { data: Record<string, unknown> }).data
  }
  return { post, get, dispose: () => ctx.dispose() }
}

const key = () => `e2e-${Math.random().toString(36).slice(2)}`

async function publish(code: string, model: unknown, fields: unknown[]) {
  const { api, dispose } = await createApiClient()
  const created = (await api.post("/api/v1/sys/workflow/definitions", {
    code,
    name: `E2E ${code}`,
    category: "E2E",
    form: { schemaVersion: 1, fields },
    model,
  })) as { id: string }
  const res = (await api.post(`/api/v1/sys/workflow/definitions/${created.id}/publish`)) as { published: boolean }
  expect(res.published).toBe(true)
  await dispose()
}

async function userId(username: string): Promise<string> {
  const { api, dispose } = await createApiClient()
  const users = (await api.get(`/api/v1/sys/workflow/directory/users?keyword=${username}`)) as {
    id: string
    username: string
  }[]
  await dispose()
  return users.find((u) => u.username === username)!.id
}

test("会签：后同意的人只改了备注，不会把先同意的人改的金额改回去", async ({ browser }) => {
  const code = `${CODE}C`
  const people = [await userId("zhaolei"), await userId("wangfang")]
  await publish(
    code,
    {
      schemaVersion: 1,
      root: {
        type: "start", id: "start",
        next: {
          type: "approval", id: "n_all", name: "会签", mode: "all",
          assignee: { kind: "user", user_ids: people }, onEmpty: "reject",
          fieldPerms: { f_amount: "editable", f_note: "editable" },
          next: null,
        },
      },
    },
    [
      { id: "f_reason", type: "text", label: "事由" },
      { id: "f_amount", type: "number", label: "核定金额" },
      { id: "f_note", type: "textarea", label: "备注" },
    ],
  )
  const s = await as("sunqiang")
  const { instance_id: id } = (await s.post("/sys/workflow/instances", {
    code,
    form: { f_reason: "会签改字段", f_amount: 100, f_note: "原备注" },
    key: key(),
  })) as { instance_id: string }
  await s.dispose()

  // 王芳先打开详情：这一刻她手上的快照是「金额 100」
  const w = await browser.newPage()
  await loginPageAs(w, "wangfang", "123456")
  await w.goto(`/workflow/inbox?id=${id}`)
  const sheet = w.getByTestId("wf-instance-sheet")
  await expect(sheet.getByTestId("wf-field-f_amount").locator("input")).toHaveValue("100")

  // 赵磊在别处把金额改成 80 并同意
  const z = await as("zhaolei")
  await z.post(`/sys/workflow/instances/${id}/actions`, { action: "approve", key: key(), form: { f_amount: 80 } })

  // 王芳只改备注就同意
  await sheet.getByTestId("wf-field-f_note").locator("textarea").fill("王芳补的备注")
  const sent = w.waitForRequest((r) => r.url().endsWith(`/instances/${id}/actions`) && r.method() === "POST")
  await sheet.getByTestId("wf-act-approve").click()
  // 🔴 只发她改过的那个字段
  expect((await sent).postDataJSON().form).toEqual({ f_note: "王芳补的备注" })
  await expect(sheet).toBeHidden()

  const detail = (await z.get(`/sys/workflow/instances/${id}`)) as {
    instance: { status: string }
    form_data: Record<string, unknown>
  }
  expect(detail.instance.status).toBe("approved")
  expect(Number(detail.form_data.f_amount)).toBe(80)
  expect(detail.form_data.f_note).toBe("王芳补的备注")
  await z.dispose()
  await w.close()
})

test("详情抽屉换一张单：上一张写了一半的意见不会留到下一张上", async ({ browser }) => {
  const code = `${CODE}K`
  await publish(
    code,
    {
      schemaVersion: 1,
      root: {
        type: "start", id: "start",
        next: {
          type: "approval", id: "n1", name: "直属主管", mode: "any",
          assignee: { kind: "dept_leader", level: 1 }, onEmpty: "reject",
          fieldPerms: { f_note: "editable" }, next: null,
        },
      },
    },
    [
      { id: "f_reason", type: "text", label: "事由" },
      { id: "f_note", type: "textarea", label: "主管备注" },
    ],
  )
  const s = await as("sunqiang")
  const start = async (reason: string) =>
    ((await s.post("/sys/workflow/instances", { code, form: { f_reason: reason }, key: key() })) as {
      instance_id: string
    }).instance_id
  const a = await start("A 单")
  const b = await start("B 单")
  await s.dispose()

  const z = await browser.newPage()
  await loginPageAs(z, "zhaolei", "123456")
  // 先看过 B（进了查询缓存）
  await z.goto(`/workflow/inbox?id=${b}`)
  const sheet = z.getByTestId("wf-instance-sheet")
  await expect(sheet.getByTestId("wf-title")).toContainText(`${code}`)
  await expect(sheet.getByTestId("wf-field-f_reason")).toContainText("B 单")
  // 应用内换到 A（同一个抽屉、不整页加载 —— 和消息中心点通知把 `?id=` 换掉是同一条路）
  await z.evaluate((next) => {
    history.pushState(history.state, "", `/workflow/inbox?id=${next}`)
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }))
  }, a)
  await expect(sheet.getByTestId("wf-field-f_reason")).toContainText("A 单")
  await sheet.getByTestId("wf-action-opinion").fill("这是给 A 的意见")
  await sheet.getByTestId("wf-field-f_note").locator("textarea").fill("A 的备注")

  // 回到 B：B 在缓存里，直接渲染
  await z.goBack()
  await expect(sheet.getByTestId("wf-field-f_reason")).toContainText("B 单")
  await expect(sheet.getByTestId("wf-action-opinion")).toHaveValue("")
  await expect(sheet.getByTestId("wf-field-f_note").locator("textarea")).toHaveValue("")
  await z.close()
})

test("发起草稿：填完最后一个字段立刻点「取消」，那次保存不丢", async ({ browser }) => {
  const code = `${CODE}D`
  await publish(
    code,
    {
      schemaVersion: 1,
      root: {
        type: "start", id: "start",
        next: {
          type: "approval", id: "n1", name: "直属主管", mode: "any",
          assignee: { kind: "dept_leader", level: 1 }, onEmpty: "reject", next: null,
        },
      },
    },
    [{ id: "f_reason", type: "text", label: "事由" }],
  )
  const p = await browser.newPage()
  await loginPageAs(p, "sunqiang", "123456")
  await p.goto(`/workflow/inbox?start=${code}`)
  const sheet = p.getByTestId("wf-start-sheet")
  await expect(sheet.getByTestId("wf-start-title")).toBeVisible()
  // 1.5 秒防抖之内关掉抽屉
  const saved = p.waitForResponse((r) => r.url().endsWith(`/drafts/${code}`) && r.request().method() === "PUT")
  await sheet.getByTestId("wf-field-f_reason").locator("input").fill("填完马上关")
  await sheet.getByRole("button", { name: "取消", exact: true }).click()
  await expect(sheet).toBeHidden()
  expect((await saved).ok()).toBe(true)

  // 应用内重开（不整页加载：缓存也要是最新的）
  await p.locator('[data-tab="/_auth/workflow/inbox"]').getByTestId("wf-start-menu").click()
  await p.getByTestId("wf-template-search").fill(code)
  await p.getByTestId(`wf-start-${code}`).click()
  await expect(sheet.getByTestId("wf-field-f_reason").locator("input")).toHaveValue("填完马上关")
  await sheet.getByTestId("wf-draft-clear").click()
  await p.close()
})
