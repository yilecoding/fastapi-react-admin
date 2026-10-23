import { readFile } from "node:fs/promises"

import { expect, test } from "../fixtures/base"
import { buildXlsx, type Cell } from "../utils/xlsx"

/**
 * 导入导出 · 列顺序（#11 · v0.4）。后端的那一大半（公式注入、数据范围、令牌、查环……）
 * 在 pytest 里（`test_export.py` / `test_import.py`），这里只守**只有界面上才坏得了**的那几处：
 *
 * - 导出的筛选条件是不是列表上的那一份（前端拼错一个参数名，后端会拒绝 —— 但前端也可能干脆没传）
 * - 下载拿到的是不是那份文件（带鉴权的下载，裸 `<a href>` 存下来的是 401 的 JSON）
 * - 导入抽屉 → 预览 → 提交这条路通不通，一份文件建一整棵树
 * - 列顺序写没写进 URL：`<Activity>` 保活会盖住「其实没写进去」，只有刷新才现形
 *
 * ⚠️ 弹层（导出菜单、列设置、导入抽屉）都渲染在 portal 里，**不在** `[data-tab=…]` 下面 ——
 * 按 testid 直接找；同一时间只会开一个，不会撞名
 */

const USER_PAGE = '[data-tab="/_auth/system/user"]'
const DEPT_PAGE = '[data-tab="/_auth/system/dept"]'
const LOGIN_LOG = '[data-tab="/_auth/log/login"]'

type Dept = { id: string; code: string; parent_id: string | null; children?: Dept[] | null }

function flatten(nodes: Dept[]): Dept[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])
}

test.describe("导出", () => {
  test("导出用户（CSV）：文件里就是当前筛选的那一批", async ({ authedPage: page }) => {
    await page.goto("/system/user?username=admin")
    await expect(page.locator(`${USER_PAGE} [data-testid="user-table"] [data-slot="table-row"]`).first()).toBeVisible()

    await page.locator(`${USER_PAGE} [data-testid="export"]`).click()
    await page.getByTestId("export-format-csv").click()
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByTestId("export-filtered").click(),
    ])
    expect(download.suggestedFilename()).toMatch(/\.csv$/)

    const text = await readFile(await download.path(), "utf8")
    // 没有 BOM 的话 Excel 按 GBK 打开，中文全是乱码
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const [header, ...rows] = text.slice(1).trimEnd().split("\r\n")
    expect(header).toContain("用户名")
    // 先断言「有」，再断言「只有筛选里的」—— 筛选没传过去的话导出的是全表，第二条会红
    expect(rows.some((r) => r.startsWith("admin,"))).toBe(true)
    expect(rows.every((r) => r.split(",")[0].includes("admin"))).toBe(true)
  })

  test("导出记录：刚导出的那一份在个人中心里，能再下载一次", async ({ authedPage: page, api }) => {
    const job = (await api.post("/api/v1/sys/users/export", { format: "xlsx" })) as {
      id: string
      status: number
      file_name: string
    }
    expect(job.status).toBe(2) // 小批量当场生成完
    try {
      await page.goto("/profile?section=exports")
      const row = page.locator('[data-panel="exports"] [data-testid="export-row"]').filter({ hasText: job.file_name })
      await expect(row).toBeVisible()
      await expect(row).toHaveAttribute("data-status", "2")

      const [download] = await Promise.all([page.waitForEvent("download"), row.getByTestId("export-download").click()])
      expect(download.suggestedFilename()).toBe(job.file_name)
      // xlsx 是 zip：拿到的是文件本身，不是一段 401 的 JSON
      const head = await readFile(await download.path())
      expect(head.subarray(0, 2).toString()).toBe("PK")
    } finally {
      await api.del(`/api/v1/sys/exports/${job.id}`)
    }
  })
})

test.describe("导入", () => {
  test("部门导入：一份文件建一整棵树，下级写在上级前面也行", async ({ authedPage: page, api }) => {
    const stamp = Date.now().toString(36).toUpperCase()
    const code = (k: string) => `E2EIMP${stamp}${k}`
    const rows: Cell[][] = [
      ["部门编码", "部门名称", "上级部门编码"],
      [code("C"), `E2E导入${stamp}C`, code("B")],
      [code("B"), `E2E导入${stamp}B`, code("A")],
      [code("A"), `E2E导入${stamp}A`, null],
    ]

    await page.goto("/system/dept")
    await page.locator(`${DEPT_PAGE} [data-testid="import-depts"]`).click()
    const sheet = page.getByTestId("dept-import-sheet")
    await expect(sheet).toBeVisible()

    try {
      await sheet.getByTestId("import-file-input").setInputFiles({
        name: "depts.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        buffer: buildXlsx(rows),
      })
      await expect(sheet.getByTestId("import-preview-row")).toHaveCount(3)
      await expect(sheet).toContainText("可导入 3 行")

      await sheet.getByTestId("confirm-import").click()
      await expect(sheet.getByTestId("import-result")).toContainText("新增 3 条")

      // 结果页说「新增 3 条」不等于树是对的 —— 从接口读回来对上下级
      const tree = flatten((await api.get(`/api/v1/sys/depts?code=E2EIMP${stamp}`)) as Dept[])
      const byCode = Object.fromEntries(tree.map((d) => [d.code, d]))
      expect(byCode[code("A")]?.parent_id).toBeNull()
      expect(byCode[code("B")]?.parent_id).toBe(byCode[code("A")]?.id)
      expect(byCode[code("C")]?.parent_id).toBe(byCode[code("B")]?.id)
    } finally {
      const tree = flatten((await api.get(`/api/v1/sys/depts?code=E2EIMP${stamp}`)) as Dept[])
      // 子部门挡着父部门删不掉：从下往上删
      for (const key of ["C", "B", "A"]) {
        const dept = tree.find((d) => d.code === code(key))
        if (dept) await api.del(`/api/v1/sys/depts/${dept.id}`)
      }
    }
  })
})

test.describe("列顺序", () => {
  test("拖动之后进 URL，刷新还在；恢复默认把它清掉", async ({ authedPage: page }) => {
    await page.goto("/log/login")
    const tab = page.locator(LOGIN_LOG)
    await expect(tab.getByTestId("login-table")).toBeVisible()
    const headers = () => tab.locator("thead th").allInnerTexts()
    const order = async () => {
      const h = await headers()
      return [h.indexOf("登录 IP"), h.indexOf("登录地点")]
    }

    // 先断言「有」：默认顺序里两列都在、IP 在前
    const [ip0, loc0] = await order()
    expect(ip0).toBeGreaterThan(-1)
    expect(ip0).toBeLessThan(loc0)

    // 键盘拖：dnd-kit 的 KeyboardSensor —— 空格拿起、方向键挪、空格放下
    await tab.getByTestId("column-settings").click()
    await page.getByTestId("column-drag-ip").focus()
    await page.keyboard.press("Space")
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Space")
    await expect(page).toHaveURL(/[?&]cols=/)
    await expect.poll(async () => {
      const [ip, loc] = await order()
      return ip > loc
    }).toBe(true)

    // 刷新还在 —— 只活在组件 state 里的话，这里就回到默认顺序了
    await page.reload()
    await expect(tab.getByTestId("login-table")).toBeVisible()
    await expect.poll(async () => {
      const [ip, loc] = await order()
      return ip > loc
    }).toBe(true)

    // 点「搜索」也还在：查询区提交时会重写整段 URL，`cols` 要在 `useQuerySearch` 的 `keep` 里，
    // 否则每搜一次列顺序就被冲掉（和 `hide` 同一个坑）
    await tab.locator("button").filter({ hasText: "搜索" }).first().click()
    await expect(page).toHaveURL(/[?&]cols=/)

    await tab.getByTestId("column-settings").click()
    await page.getByTestId("columns-reset").click()
    await expect(page).not.toHaveURL(/[?&]cols=/)
    await expect.poll(async () => {
      const [ip, loc] = await order()
      return ip < loc
    }).toBe(true)
  })
})
