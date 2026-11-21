import { type Page, type Request, request } from "@playwright/test"

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

// ── 评审跟进（#403）─────────────────────────────────────────────────────────

test("会签：改了又改回原值的字段不算改过，不会把先同意的人改的值盖回去", async ({ browser }) => {
  const code = `${CODE}R`
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
    form: { f_reason: "改回原值", f_amount: 100, f_note: "原备注" },
    key: key(),
  })) as { instance_id: string }
  await s.dispose()

  const w = await browser.newPage()
  await loginPageAs(w, "wangfang", "123456")
  await w.goto(`/workflow/inbox?id=${id}`)
  const sheet = w.getByTestId("wf-instance-sheet")
  const amount = sheet.getByTestId("wf-field-f_amount").locator("input")
  await expect(amount).toHaveValue("100")
  // 王芳把金额改成 90、想想又改回 100
  await amount.fill("90")
  await amount.fill("100")

  // 赵磊这时把金额改成 80 并同意
  const z = await as("zhaolei")
  await z.post(`/sys/workflow/instances/${id}/actions`, { action: "approve", key: key(), form: { f_amount: 80 } })

  await sheet.getByTestId("wf-field-f_note").locator("textarea").fill("王芳补的备注")
  const sent = w.waitForRequest((r) => r.url().endsWith(`/instances/${id}/actions`) && r.method() === "POST")
  await sheet.getByTestId("wf-act-approve").click()
  // 🔴 金额和她打开时一样 = 没改过，不发
  expect((await sent).postDataJSON().form).toEqual({ f_note: "王芳补的备注" })
  await expect(sheet).toBeHidden()
  const detail = (await z.get(`/sys/workflow/instances/${id}`)) as { form_data: Record<string, unknown> }
  expect(Number(detail.form_data.f_amount)).toBe(80)
  await z.dispose()
  await w.close()
})

/** 只有一个「事由」字段的流程：草稿那几条用 */
async function publishDraftFlow(code: string) {
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
}

async function serverDraft(code: string): Promise<string | undefined> {
  const s = await as("sunqiang")
  const d = (await s.get(`/sys/workflow/drafts/${code}`)) as { form?: Record<string, string> } | null
  await s.dispose()
  return d?.form?.f_reason
}

async function openStart(p: Page, code: string) {
  await p.locator('[data-tab="/_auth/workflow/inbox"]').getByTestId("wf-start-menu").click()
  await p.getByTestId("wf-template-search").fill(code)
  await p.getByTestId(`wf-start-${code}`).click()
}

const isDraftPut = (code: string) => (r: Request) => r.url().endsWith(`/drafts/${code}`) && r.method() === "PUT"

test("发起草稿：关抽屉时补发的那次，等路上那次落地之后才发，服务端留的是最后打的字", async ({ browser }) => {
  const code = `${CODE}Q`
  await publishDraftFlow(code)
  const p = await browser.newPage()
  await loginPageAs(p, "sunqiang", "123456")
  // 第一次 PUT 在路上多走 2.5 秒
  let first = true
  await p.route(`**/drafts/${code}`, async (route) => {
    if (route.request().method() === "PUT" && first) {
      first = false
      await new Promise((r) => setTimeout(r, 2500))
    }
    await route.fallback()
  })
  await p.goto(`/workflow/inbox?start=${code}`)
  const sheet = p.getByTestId("wf-start-sheet")
  const input = sheet.getByTestId("wf-field-f_reason").locator("input")
  await expect(input).toBeVisible()
  const firstPut = p.waitForRequest(isDraftPut(code))
  await input.fill("第一版")
  await firstPut
  let done = 0
  p.on("requestfinished", (r) => {
    if (isDraftPut(code)(r)) done++
  })
  await input.fill("第二版")
  await sheet.getByRole("button", { name: "取消", exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect.poll(() => done, { timeout: 10_000 }).toBe(2)
  // 🔴 原来补发的那次不等，先到服务端，路上那次后到 —— 留下的是「第一版」
  expect(await serverDraft(code)).toBe("第二版")
  await p.close()
})

test("发起草稿：提交失败之后点「取消」，最后打的字照样补存", async ({ browser }) => {
  const code = `${CODE}F`
  await publishDraftFlow(code)
  const p = await browser.newPage()
  await loginPageAs(p, "sunqiang", "123456")
  // 提交慢 2 秒再失败：1.5 秒的防抖在「提交中」触发
  await p.route(/\/api\/v1\/sys\/workflow\/instances$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    await new Promise((r) => setTimeout(r, 2000))
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code: 400, msg: "E2E 造的提交失败", data: null }),
    })
  })
  await p.goto(`/workflow/inbox?start=${code}`)
  const sheet = p.getByTestId("wf-start-sheet")
  const input = sheet.getByTestId("wf-field-f_reason").locator("input")
  await expect(input).toBeVisible()
  await input.fill("提交失败后取消")
  await sheet.getByTestId("wf-start-submit").click()
  await expect(p.getByText("E2E 造的提交失败")).toBeVisible()
  const saved = p.waitForRequest(isDraftPut(code), { timeout: 5_000 })
  await sheet.getByRole("button", { name: "取消", exact: true }).click()
  await expect(sheet).toBeHidden()
  // 🔴 原来防抖在提交中触发时把「排着的那次」清掉了，关抽屉时没东西可补
  expect((await saved).postDataJSON().form).toEqual({ f_reason: "提交失败后取消" })
  await p.close()
})

test("发起草稿：关抽屉时补发失败要看得见", async ({ browser }) => {
  const code = `${CODE}E`
  await publishDraftFlow(code)
  const p = await browser.newPage()
  await loginPageAs(p, "sunqiang", "123456")
  await p.route(`**/drafts/${code}`, (route) => (route.request().method() === "PUT" ? route.abort() : route.fallback()))
  await p.goto(`/workflow/inbox?start=${code}`)
  const sheet = p.getByTestId("wf-start-sheet")
  const input = sheet.getByTestId("wf-field-f_reason").locator("input")
  await expect(input).toBeVisible()
  await input.fill("这次存不上")
  await sheet.getByRole("button", { name: "取消", exact: true }).click()
  await expect(sheet).toBeHidden()
  // 🔴 抽屉已经卸载，状态栏那句「草稿没存上」画不出来 —— 原来什么提示都没有（硬纪律 9）
  await expect(p.getByText("关闭前最后填的内容没存上")).toBeVisible()
  await p.close()
})

test("发起草稿：补发还在路上就重开，看到的是刚填的", async ({ browser }) => {
  const code = `${CODE}O`
  await publishDraftFlow(code)
  const p = await browser.newPage()
  await loginPageAs(p, "sunqiang", "123456")
  await p.route(`**/drafts/${code}`, async (route) => {
    if (route.request().method() === "PUT") await new Promise((r) => setTimeout(r, 3000))
    await route.fallback()
  })
  await p.goto(`/workflow/inbox?start=${code}`)
  const sheet = p.getByTestId("wf-start-sheet")
  const input = sheet.getByTestId("wf-field-f_reason").locator("input")
  await expect(input).toBeVisible()
  const landed = p.waitForResponse((r) => isDraftPut(code)(r.request()))
  await input.fill("马上重开")
  await sheet.getByRole("button", { name: "取消", exact: true }).click()
  await expect(sheet).toBeHidden()
  await openStart(p, code)
  // 🔴 原来那次 PUT 落地之前缓存还是旧的（空），重开是白表，接着打字会把服务端的新草稿盖掉
  await expect(input).toHaveValue("马上重开")
  await landed
  await p.close()
})
