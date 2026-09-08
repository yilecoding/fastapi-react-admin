import { expect, test } from "../fixtures/base"

import { buildXlsx, type Cell } from "../utils/xlsx"

import type { ApiClient } from "../fixtures/base"

/**
 * 用户批量导入（预览 → 提交）。
 *
 * 盯的是**「导入成功了、人数对不上」**那一类问题——它们全都不报错：
 * 文件内重名、部门编码查不到、某一列拼错导致整列数据丢掉。
 * 接口正常时，防没防住这几件事在界面上看不出任何区别。
 *
 * ⚠️ 这批用例要求 `.env.e2e` 里配了 `USER_IMPORT_DEFAULT_PASSWORD`
 * （`.env.e2e.example` 里已经有了，CI 是 `cp` 过去的）。没配的话导入功能
 * 是**关闭**的，预览接口直接报错——那时这些用例会红在「预览失败」上。
 */

const PREFIX = "e2e_imp_"

/** 从**接口**现读编码，不写死。种子会变，写死的失败方式还可能是「没红但指向了另一条数据」 */
async function refs(api: ApiClient) {
  const depts = (await api.get("/api/v1/sys/depts")) as Array<{ code: string }>
  const roles = (await api.get("/api/v1/sys/roles/all")) as Array<{ code: string }>
  return { dept: depts[0].code, role: roles[0].code }
}

/** 收尾：把这批用户删掉。用接口的逻辑删除就够了——同名还能再建，不影响下一轮 */
async function purge(api: ApiClient, usernames: string[]) {
  for (const username of usernames) {
    const page = (await api.get(`/api/v1/sys/users?username=${username}`)) as {
      items: Array<{ id: string; username: string }>
    }
    for (const u of page.items) {
      if (u.username.startsWith(PREFIX)) await api.del(`/api/v1/sys/users/${u.id}`)
    }
  }
}

test.describe("用户批量导入", () => {
  test("预览把三类问题各自指出来，提交只创建干净的那些", async ({ authedPage: page, api }) => {
    const { dept, role } = await refs(api)
    const stamp = Date.now().toString(36)
    const ann = `${PREFIX}${stamp}_ann`
    const bob = `${PREFIX}${stamp}_bob`
    const dup = `${PREFIX}${stamp}_dup`

    const rows: Cell[][] = [
      ["username", "nickname", "email", "phone", "dept_code", "role_codes", "备注列"],
      // 手机号刻意写成**数字** —— Excel 里直接打手机号就是这个形状，
      // 解析层要把它归一成纯数字串（裸 str() 会得到 '13800138001.0'）
      [ann, "安", `${ann}@example.com`, 13800138001, dept, role, "随手写的备注"],
      [bob, "博", null, null, dept, role, null],
      // 库里已有：admin 一定存在
      ["admin", "撞名", null, null, dept, role, null],
      [dup, "重复一", null, null, dept, role, null],
      [dup, "重复二", null, null, dept, role, null],
      [`${PREFIX}${stamp}_bad`, "坏部门", null, null, "NO_SUCH_DEPT", role, null],
      // 尾部空行：Excel 里极常见，必须被跳过而不是当成「用户名没填」
      [null, null, null, null, null, null, null],
    ]

    await page.goto("/system/user")
    await page.getByTestId("user-table").waitFor()
    await page.getByTestId("import-users").click()
    await expect(page.getByTestId("user-import-sheet")).toBeVisible()

    await page.getByTestId("import-file-input").setInputFiles({
      name: "users.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildXlsx(rows),
    })

    const sheet = page.getByTestId("user-import-sheet")
    await expect(page.getByTestId("import-preview-table")).toBeVisible()

    // 6 行数据（第 8 行是空行，被跳过）
    await expect(page.getByTestId("import-preview-row")).toHaveCount(6)
    await expect(sheet).toContainText("共 6 行")
    await expect(sheet).toContainText("可导入 3 行")
    await expect(sheet).toContainText("有问题 3 行")
    await expect(sheet).toContainText("已跳过 1 个空行")

    // 🔴 未识别的表头必须**说出来**：`备注列` 没被认领，它那一列的数据全丢了，
    // 而整份文件照样解析成功——不说的话没有任何现象
    await expect(sheet).toContainText("备注列")

    // 三类问题各自的原文。只断言「有 3 行有问题」是不够的：
    // 三条走的是三条不同的代码路径（库内查重 / 文件内查重 / 编码解析），
    // 任意一条坏掉，另外两条都能把计数凑够
    const row = (n: number) => page.locator(`[data-testid="import-preview-row"][data-row-no="${n}"]`)
    await expect(row(4)).toContainText("用户名已注册")
    await expect(row(6)).toContainText("在文件里重复了")
    await expect(row(7)).toContainText("NO_SUCH_DEPT")

    await page.getByTestId("confirm-import").click()
    await expect(page.getByTestId("import-result")).toBeVisible()
    await expect(page.getByTestId("import-result")).toContainText("成功 3 个")
    // 没有强制首次改密的机制，这句提示是唯一的告知渠道
    await expect(page.getByTestId("import-result")).toContainText("系统默认密码")

    // 真的进库了吗 —— 结果页说「成功」不等于列表里有
    await page.getByTestId("import-done").click()
    await page.goto(`/system/user?username=${ann}`)
    // ⚠️ `{ exact: true }` 不能省：用户名也出现在**邮箱**里
    // （`..._ann@example.com`），不精确匹配会撞两个元素 → strict mode violation
    await expect(page.getByTestId("user-table").getByText(ann, { exact: true })).toBeVisible()

    await purge(api, [ann, bob, dup])
  })

  test("同一个 import_token 不能提交两次", async ({ authedPage: page, api }) => {
    // 🔴 不作废 token 的话，重放一次就是**重复建号**：第二次撞用户名唯一约束报
    // 「导入失败」，而库里已经多了第一批人。服务端在建号**之前**就把 token 删掉。
    const { dept, role } = await refs(api)
    const name = `${PREFIX}${Date.now().toString(36)}_once`

    await page.goto("/system/user")
    await page.getByTestId("user-table").waitFor()
    await page.getByTestId("import-users").click()

    // 把预览返回的**真** token 截下来 —— 这条用例的全部意义就是「拿用过的那个
    // 再用一次」。换成一个瞎编的 token 只能测到「未知 token 被拒」，
    // 那条路径就算把「提交前删 token」整个删掉也照样是绿的
    const [previewRes] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/sys/users/import/preview")),
      page.getByTestId("import-file-input").setInputFiles({
        name: "users.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: buildXlsx([
          ["username", "nickname", "dept_code", "role_codes"],
          [name, "一次性", dept, role],
        ]),
      }),
    ])
    const token = ((await previewRes.json()) as { data: { import_token: string } }).data.import_token
    expect(token).toBeTruthy()

    await expect(page.getByTestId("import-preview-table")).toBeVisible()
    await page.getByTestId("confirm-import").click()
    await expect(page.getByTestId("import-result")).toContainText("成功 1 个")

    // 同一个 token 再打一次：必须被拒（`api.post` 对非 200 信封会抛）
    await expect(
      api.post("/api/v1/sys/users/import/commit", { import_token: token, exclude_rows: [] })
    ).rejects.toThrow()

    // 而且库里只有一个 —— 「被拒了」和「又建了一个」要分开验
    const listed = (await api.get(`/api/v1/sys/users?username=${name}`)) as { total: number }
    expect(listed.total).toBe(1)

    await purge(api, [name])
  })

  test("非 xlsx 文件被挡住，并且说得出原因", async ({ authedPage: page }) => {
    // 硬纪律 9：失败要是**可见状态**。这里最容易退化成「选了文件、什么都没发生」
    await page.goto("/system/user")
    await page.getByTestId("user-table").waitFor()
    await page.getByTestId("import-users").click()
    await page.getByTestId("import-file-input").setInputFiles({
      name: "users.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("username,dept_code\na,HQ\n"),
    })

    await expect(page.getByTestId("import-preview-error")).toBeVisible()
    await expect(page.getByTestId("import-preview-error")).toContainText("xlsx")
    // 预览表不该出现——但入口还在，用户能直接换一份文件重来
    await expect(page.getByTestId("import-preview-table")).toHaveCount(0)
    await expect(page.getByTestId("pick-import-file")).toBeVisible()
  })
})
