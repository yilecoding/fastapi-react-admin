import { expect, test } from '../fixtures/base'

const failure = { status: 502, contentType: 'application/json', body: JSON.stringify({ code: 502, msg: 'grant read failed', data: null }) }

test.describe('授权读取失败不得覆盖现有绑定 #327', () => {
  for (const kind of ['menus', 'scopes', 'tree'] as const) {
    test(`${kind}: 阻止编辑，重试恢复原有授权`, async ({ authedPage: page, api }) => {
      const roles = await api.get('/api/v1/sys/roles/all') as { id: string }[]
      const role = roles[0]
      const endpoint = `/api/v1/sys/roles/${role.id}/${kind === 'scopes' ? 'scopes' : 'menus'}`
      const before = await api.get(endpoint)
      let fail = true
      const target = kind === 'tree' ? '/api/v1/sys/menus' : endpoint
      const pattern = (url: URL) => url.pathname === target
      await page.route(pattern, route => fail ? route.fulfill(failure) : route.fallback())
      await page.goto(`/system/role?role=${role.id}&tab=${kind === 'scopes' ? 'scopes' : 'perms'}`)
      const panel = page.getByTestId(kind === 'scopes' ? 'role-scopes' : 'perm-matrix')
      await expect(panel.getByTestId('query-error')).toBeVisible({ timeout: 15000 })
      await expect(panel.getByTestId(kind === 'scopes' ? 'scope-save' : 'perm-save')).toBeDisabled()
      expect(await api.get(endpoint)).toEqual(before)
      fail = false
      await panel.getByTestId('query-error-retry').click()
      await expect(panel.getByTestId('query-error')).toBeHidden()
      await expect(panel.locator('[role=checkbox]').first()).toBeEnabled()
      expect(await api.get(endpoint)).toEqual(before)
    })
  }

  test('规则读取失败禁止新建和引用，重试恢复', async ({ authedPage: page, api }) => {
    const scopes = await api.get('/api/v1/sys/data-scopes?page=1&size=100') as { items: { id: string }[] }
    const id = scopes.items[0].id
    const endpoint = `/api/v1/sys/data-scopes/${id}/rules`
    const before = await api.get(endpoint)
    let fail = true
    await page.route(url => url.pathname === endpoint, route => fail ? route.fulfill(failure) : route.fallback())
    await page.goto(`/system/data-permission?scope=${id}`)
    const panel = page.getByTestId('rules-panel')
    await expect(panel.getByTestId('query-error')).toBeVisible({ timeout: 15000 })
    await expect(panel.getByTestId('rule-add')).toBeDisabled()
    await expect(panel.getByTestId('rule-link')).toBeDisabled()
    fail = false
    await panel.getByTestId('query-error-retry').click()
    await expect(panel.getByTestId('query-error')).toBeHidden()
    await expect(panel.getByTestId('rule-link')).toBeEnabled()
    expect(await api.get(endpoint)).toEqual(before)
  })

  test('规则选择器读取失败可重试且不写绑定', async ({ authedPage: page, api }) => {
    const scopes = await api.get('/api/v1/sys/data-scopes?page=1&size=100') as { items: { id: string }[] }
    const id = scopes.items[0].id
    const endpoint = `/api/v1/sys/data-scopes/${id}/rules`
    const before = await api.get(endpoint)
    let fail = true
    let writes = 0
    await page.route(url => url.pathname === '/api/v1/sys/data-rules/all', route => fail ? route.fulfill(failure) : route.fallback())
    await page.route(url => url.pathname === endpoint, route => {
      if (route.request().method() === 'PUT') writes++
      return route.fallback()
    })
    await page.goto(`/system/data-permission?scope=${id}`)
    await page.getByTestId('rule-link').click()
    const picker = page.getByTestId('rule-picker')
    await expect(picker.getByTestId('query-error')).toBeVisible({ timeout: 15000 })
    await expect(picker.getByTestId('rule-picker-submit')).toBeDisabled()
    fail = false
    await picker.getByTestId('query-error-retry').click()
    await expect(picker.getByTestId('query-error')).toBeHidden()
    await expect(picker.getByTestId(/^rule-picker-row-/).first()).toBeVisible()
    expect(writes).toBe(0)
    expect(await api.get(endpoint)).toEqual(before)
  })
})
