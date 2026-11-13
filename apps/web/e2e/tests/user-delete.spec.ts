import { expect, test, loginPageAs } from '../fixtures/base'
import { uniqueCode } from '../utils/ids'

test('有删除权限的普通管理员：本人不可删或勾选，其他普通账号可以删除', async ({ page, api }) => {
  const prefix = uniqueCode('DEL').toLowerCase()
  const password = 'Delete@123456'
  const dept = ((await api.get('/api/v1/sys/depts')) as Array<{ id: string }>)[0]
  const roleCode = prefix.toUpperCase()
  const made: Array<{ id: string; username: string }> = []
  let roleId: string | undefined
  try {
    await api.post('/api/v1/sys/roles', { code: roleCode, name: roleCode, status: 1, is_filter_scopes: false })
    roleId = ((await api.get('/api/v1/sys/roles/all')) as Array<{ id: string; code: string }>)
      .find((r) => r.code === roleCode)!.id
    type Menu = { id: string; children?: Menu[] }
    const ids = (nodes: Menu[]): string[] => nodes.flatMap((m) => [m.id, ...ids(m.children ?? [])])
    await api.put(`/api/v1/sys/roles/${roleId}/menus`, { menus: ids(await api.get('/api/v1/sys/menus') as Menu[]) })
    for (const key of ['actor', 'target']) {
      const username = `${prefix}_${key}`
      const user = await api.post('/api/v1/sys/users', {
        username, password, nickname: username, dept_id: dept.id, roles: [roleId],
      }) as { id: string }
      made.push({ id: user.id, username })
    }
    const [actor, target] = made
    await api.put(`/api/v1/sys/users/${actor.id}/permissions?type=staff`)
    await loginPageAs(page, actor.username, password)
    await page.goto(`/system/user?username=${prefix}`)
    const pane = page.locator('[data-tab="/_auth/system/user"]')
    const ownSelect = pane.getByTestId(`select-row-${actor.id}`)
    const targetSelect = pane.getByTestId(`select-row-${target.id}`)
    await expect(ownSelect).toBeDisabled()
    await expect(targetSelect).toBeEnabled()
    await pane.getByTestId('select-all').click()
    await expect(ownSelect).not.toBeChecked()
    await expect(targetSelect).toBeChecked()
    await targetSelect.click()

    await pane.getByTestId(`row-actions-${actor.username}`).click()
    await expect(page.getByTestId(`delete-${actor.username}`)).toBeDisabled()
    await page.keyboard.press('Escape')
    await pane.getByTestId(`row-actions-${target.username}`).click()
    await page.getByTestId(`delete-${target.username}`).click()
    await expect(page.getByTestId('confirm-dialog')).toContainText(target.username)
    await page.getByTestId('confirm-ok').click()
    await expect(targetSelect).toHaveCount(0)
    await expect(ownSelect).toBeVisible()
  } finally {
    for (const user of made) {
      const remaining = await api.get(`/api/v1/sys/users?username=${user.username}`) as { items: Array<{ id: string }> }
      if (remaining.items.some((u) => u.id === user.id)) await api.del(`/api/v1/sys/users/${user.id}`)
    }
    if (roleId) await api.del('/api/v1/sys/roles', { pks: [roleId] })
  }
})
