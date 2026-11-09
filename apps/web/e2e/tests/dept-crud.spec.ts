import { expect, test } from "../fixtures/base"
import { uniqueCode } from "../utils/ids"

test.describe("部门管理", () => {
  test("新增 → 重复编码冲突可见 → 编辑禁改编码 → 删除二次确认", async ({ authedPage: page }) => {
    const code = uniqueCode("E2EDEPT")
    const name = `E2E部门${code}`

    await page.goto(`/system/dept?code=${code}`)
    await expect(page.getByTestId("page-title")).toHaveText("部门管理")

    // 新增
    await page.getByTestId("add-dept").click()
    await page.getByTestId("d-name").fill(name)
    await page.getByTestId("d-code").fill(code)
    await page.getByTestId("d-submit").click()
    await expect(page.getByTestId(`dept-row-${name}`)).toBeVisible()

    // 重复编码：409 冲突必须在表单上可见（硬纪律 9），不能被吞掉变成「静默没反应」
    await page.getByTestId("add-dept").click()
    await page.getByTestId("d-name").fill(`${name}-dup`)
    await page.getByTestId("d-code").fill(code)
    await page.getByTestId("d-submit").click()
    await expect(page.getByTestId("form-error")).toBeVisible()
    await expect(page.getByTestId("form-error")).toContainText("已存在")
    await page.getByRole("button", { name: "取消" }).click()

    // 编辑：编码框禁用、值不变 —— 契约上就没给 UpdateDeptParam 这个字段，
    // 不是靠前端"禁用输入框"这一层撑着
    await page.getByTestId(`dept-actions-${name}`).click()
    await page.getByTestId(`dept-edit-${name}`).click()
    await expect(page.getByTestId("d-code")).toBeDisabled()
    await expect(page.getByTestId("d-code")).toHaveValue(code)
    await page.getByRole("button", { name: "取消" }).click()

    // 删除：必须过二次确认，不能一点就没
    await page.getByTestId(`dept-actions-${name}`).click()
    await page.getByTestId(`dept-delete-${name}`).click()
    await expect(page.getByTestId("confirm-dialog")).toBeVisible()
    await page.getByTestId("confirm-ok").click()
    await expect(page.getByTestId(`dept-row-${name}`)).not.toBeVisible()
  })

  test("同一父级下不能重名，不同父级下可以（部门重名 bug 的回归）", async ({ authedPage: page, api }) => {
    const suffix = uniqueCode("E2ESIB")
    const parentACode = `${suffix}A`
    const parentBCode = `${suffix}B`
    const childName = `E2E同名子部门${suffix}`

    // 两个父部门走接口直接造，不占用这条测试要验证的 UI 步骤
    await api.post("/api/v1/sys/depts", {
      code: parentACode,
      name: `E2E父级A${suffix}`,
      status: 1,
      sort: 0,
    })
    const parentAId = (
      (await api.get(`/api/v1/sys/depts?code=${parentACode}`)) as Array<{ id: string }>
    )[0].id
    await api.post("/api/v1/sys/depts", {
      code: parentBCode,
      name: `E2E父级B${suffix}`,
      status: 1,
      sort: 0,
    })
    const parentBId = (
      (await api.get(`/api/v1/sys/depts?code=${parentBCode}`)) as Array<{ id: string }>
    )[0].id

    // 不按名字/编码筛选 —— 筛了的话「上级部门」下拉的选项来自当前**筛选后**的树，
    // 两个刚造的父部门名字里没有 childName，会从下拉里消失
    await page.goto("/system/dept")

    // 父级 A 下建一个
    await page.getByTestId("add-dept").click()
    await page.getByTestId("d-name").fill(childName)
    await page.getByTestId("d-code").fill(`${suffix}C1`)
    await page.getByTestId("d-parent").click()
    await page.getByRole("option", { name: new RegExp(`E2E父级A${suffix}`) }).click()
    await page.getByTestId("d-submit").click()
    await expect(page.getByTestId(`dept-row-${childName}`)).toBeVisible()

    // 父级 B 下建同名的一个 —— 应该成功，这正是修掉的那个 bug
    await page.getByTestId("add-dept").click()
    await page.getByTestId("d-name").fill(childName)
    await page.getByTestId("d-code").fill(`${suffix}C2`)
    await page.getByTestId("d-parent").click()
    await page.getByRole("option", { name: new RegExp(`E2E父级B${suffix}`) }).click()
    await page.getByTestId("d-submit").click()
    await expect(page.getByTestId("form-error")).not.toBeVisible()

    // 默认态就是展开的（`useTreeFold`：没有 fold=all 时 `isOpen` 返回 true），
    // 两棵子树下的同名行本来就都在，不用点「展开全部」——点了反而会把它们折叠掉
    await expect(page.getByTestId(`dept-row-${childName}`)).toHaveCount(2)

    // 收尾：父级下还有子部门时删不掉，所以先删子再删父
    const children = await api.get(`/api/v1/sys/depts?name=${encodeURIComponent(childName)}`)
    for (const child of children as Array<{ id: string }>) {
      await api.del(`/api/v1/sys/depts/${child.id}`)
    }
    await api.del(`/api/v1/sys/depts/${parentAId}`)
    await api.del(`/api/v1/sys/depts/${parentBId}`)
  })

  /**
   * 删不掉的部门（2026-11-06 本地点出来的）。原来弹窗写的是「若该部门下仍有子部门或用户，后端会拒绝」，
   * 点了「删除」之后那句问题被一行红字整个顶掉，按钮照样能点 —— 看不出在删谁、该怎么办。
   */
  test("删不掉的部门：有子部门时先说清楚、不给按钮；被接口拒绝时问题还在、原因另起一条", async ({ authedPage: page, api }) => {
    const code = uniqueCode("E2EDEL")
    const parentName = `E2E删父${code}`
    const childName = `E2E删子${code}`
    await api.post("/api/v1/sys/depts", { code, name: parentName, status: 1, sort: 0 })
    const parentId = ((await api.get(`/api/v1/sys/depts?code=${code}`)) as Array<{ id: string }>)[0].id
    await api.post("/api/v1/sys/depts", { code: `${code}K`, name: childName, parent_id: parentId, status: 1, sort: 0 })

    try {
      await page.goto("/system/dept")

      // 树上看得见子部门 → 这一步一定会被拒：直接说怎么办，「删除」不可点
      await page.getByTestId(`dept-actions-${parentName}`).click()
      await page.getByTestId(`dept-delete-${parentName}`).click()
      await expect(page.getByTestId("confirm-dialog")).toContainText("还有 1 个子部门")
      await expect(page.getByTestId("confirm-ok")).toBeDisabled()
      await page.keyboard.press("Escape")
      await expect(page.getByTestId("confirm-dialog")).toHaveCount(0)

      // 前端看不出来的（部门下有成员）：接口拒了，原来的问题留着，原因单独一条
      await page.route("**/api/v1/sys/depts/*", (route) =>
        route.request().method() === "DELETE"
          ? route.fulfill({
              status: 409,
              contentType: "application/json",
              body: JSON.stringify({ code: 409, msg: "部门下存在用户，无法删除", data: null }),
            })
          : route.fallback()
      )
      await page.getByTestId(`dept-actions-${childName}`).click()
      await page.getByTestId(`dept-delete-${childName}`).click()
      await page.getByTestId("confirm-ok").click()
      await expect(page.getByTestId("confirm-error")).toContainText("部门下存在用户")
      await expect(page.getByTestId("confirm-dialog")).toContainText(`确定删除「${childName}」`)
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" })
      const kids = (await api.get(`/api/v1/sys/depts?code=${code}K`)) as Array<{ id: string }>
      for (const k of kids) await api.del(`/api/v1/sys/depts/${k.id}`)
      await api.del(`/api/v1/sys/depts/${parentId}`)
    }
  })
})
