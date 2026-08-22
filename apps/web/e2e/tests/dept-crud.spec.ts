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
})
