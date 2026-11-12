import { API_BASE, expect, test } from '../fixtures/base'

test('跨账号刷新不能重放写请求，清理旧页面 #324', async ({ authedPage: page }) => {
  await page.goto('/system/dept')
  await expect(page.getByTestId('tab-bar')).toContainText('部门管理')
  let writes = 0
  await page.route(url => url.pathname === '/api/v1/identity-probe', route => {
    writes++
    return route.fulfill({ status: writes === 1 ? 401 : 200, json: { code: writes === 1 ? 401 : 200, msg: 'probe', data: null } })
  })
  await page.route(`${API_BASE}/api/v1/auth/refresh`, async route => {
    const token = 'e30.' + Buffer.from(JSON.stringify({ sub: 'different-account', session_uuid: 'other' })).toString('base64url') + '.sig'
    await route.fulfill({ json: { code: 200, msg: 'ok', data: { access_token: token } } })
  })
  const result = await page.evaluate(async () => {
    // Exercise the production client with an isolated failing endpoint.
    const moduleUrl = performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((name) => name.includes('/api-client/client.ts')).at(-1)
    if (!moduleUrl) throw new Error('production API client was not loaded')
    const { api } = await import(/* @vite-ignore */ moduleUrl)
    try {
      await api.PUT('/api/v1/identity-probe', { body: { name: 'old account draft' } })
      return 'replayed'
    } catch {
      return 'rejected'
    }
  })
  expect(result).toBe('rejected')
  expect(writes).toBe(1)
  await expect(page).toHaveURL(/sign-in/)
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('admin:tabs') ?? '{}').state.tabs)).toEqual([])
})

test('刷新恢复不同账号前移除旧页签 #324', async ({ authedPage: page }) => {
  await page.goto('/system/dept')
  await expect(page.getByTestId('tab-bar')).toContainText('部门管理')
  await page.evaluate(() => {
    const data = JSON.parse(sessionStorage.getItem('admin:tabs') ?? '{}')
    data.state.ownerId = 'previous-account'
    sessionStorage.setItem('admin:tabs', JSON.stringify(data))
  })
  await page.goto('/dashboard')
  await expect(page.getByTestId('tab-bar')).toContainText('仪表盘')
  await expect(page.getByTestId('tab-bar')).not.toContainText('部门管理')
  await expect(page.locator('[data-tab="/_auth/system/dept"]')).toHaveCount(0)
})
