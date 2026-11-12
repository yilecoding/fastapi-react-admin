import { expect, test, type Page } from '@playwright/test'

// #330：只测浏览器的提交生命周期。所有 API 都在浏览器拦截，不建公告、不发广播。
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

const notice = {
  id: '2049629108245233664', title: '公告提交回归', content: '<p>公告正文</p>',
  type: 0, status: 1, pinned: false, level: 0, expire_time: null, popup: false,
  require_ack: false, publish_time: null, public: false, attachment_count: 0, audience: [],
  created_time: '2026-11-12T08:00:00Z', updated_time: null,
}

async function mockNoticeApi(page: Page, { editing = false, failFirst = false } = {}) {
  const syncStarted = deferred()
  const releaseSync = deferred()
  const unexpected: string[] = []
  const writes: string[] = []
  let saved = editing ? notice : null
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const reply = (data: unknown) => route.fulfill({ json: { code: 200, msg: 'ok', data } })
    if (path === '/api/v1/auth/refresh') {
      const claims = Buffer.from(JSON.stringify({ sub: '1', session_uuid: 'notice-submit' })).toString('base64url')
      return reply({ access_token: `e30.${claims}.test` })
    }
    if (path === '/api/v1/sys/users/me') return reply({
      id: '1', uuid: 'notice-submit', username: 'admin', nickname: '管理员', email: null,
      avatar: null, phone: null, phone_verified_time: null, status: 1, is_superuser: true,
      is_staff: true, dept_id: null, dept: null, roles: [], join_time: notice.created_time,
      last_login_time: null, timezone: 'Asia/Shanghai',
    })
    if (['/api/v1/auth/codes', '/api/v1/sys/menus/sidebar', '/api/v1/sys/configs/dev-sandbox-gate',
      '/api/v1/sys/notices/feed/popups', '/api/v1/sys/notices/feed/banner',
      `/api/v1/sys/files/targets/NOTICE/${notice.id}`,
    ].includes(path)) return reply([])
    if (path === '/api/v1/sys/notifications/unread-count') {
      return reply({ total: 0, by_category: {}, requires_ack_count: 0 })
    }
    if (path === '/api/v1/sys/notices' && method === 'GET') {
      return reply({ items: saved ? [saved] : [], total: saved ? 1 : 0, page: 1, size: 20, total_pages: 1 })
    }
    if ((path === '/api/v1/sys/notices' && method === 'POST') ||
        (path === `/api/v1/sys/notices/${notice.id}` && method === 'PUT')) {
      writes.push(method)
      if (failFirst && writes.length === 1) {
        return route.fulfill({ status: 400, json: { code: 400, msg: '回归测试：保存失败', data: null } })
      }
      saved = { ...notice, ...request.postDataJSON() }
      return reply(method === 'POST' ? saved : null)
    }
    if (path === `/api/v1/sys/files/targets/NOTICE_CONTENT/${notice.id}`) {
      syncStarted.resolve()
      await releaseSync.promise
      return reply([])
    }
    unexpected.push(`${method} ${path}`)
    return route.fulfill({ status: 500, json: { code: 500, msg: 'Unexpected test request', data: null } })
  })
  return { syncStarted, releaseSync, writes, unexpected }
}

async function openForm(page: Page, editing: boolean, navigate = true) {
  if (navigate) await page.goto('/plugins/notice')
  const tab = page.locator('[data-tab="/_auth/plugins/notice"]')
  if (editing) {
    await tab.getByTestId(`notice-actions-${notice.id}`).click()
    await page.getByTestId(`notice-edit-${notice.id}`).click()
  } else {
    await tab.getByTestId('add-notice').click()
    await page.getByTestId('n-title').fill(notice.title)
    await page.getByTestId('n-content-content').locator('.ProseMirror').fill('公告正文')
  }
  return page.getByRole('dialog', { name: editing ? '编辑通知公告' : '新增通知公告', exact: true })
}

for (const editing of [false, true]) {
  test(`${editing ? '编辑' : '新建'}公告：保存后图片同步未结束时，提交保持禁用`, async ({ page }) => {
    const mock = await mockNoticeApi(page, { editing })
    try {
      const sheet = await openForm(page, editing)
      const submit = sheet.getByTestId('n-submit')
      await submit.click()
      // 走到图片读取说明 create/update 及其 onSuccess 缓存失效已经结束。
      await mock.syncStarted.promise
      await expect(sheet).toBeVisible()
      await expect(submit).toBeDisabled()
      await expect(submit.locator('.animate-spin')).toBeVisible()
      await sheet.getByTestId('n-title').press('Enter')
      // 原生 submit 事件也不能绕过保护（按钮被禁用时，浏览器通常会拦住回车）。
      await submit.evaluate((button) => {
        button.closest('form')!.requestSubmit()
        button.closest('form')!.requestSubmit()
      })
      mock.releaseSync.resolve()
      await expect(sheet).toBeHidden()
      expect(mock.writes).toEqual([editing ? 'PUT' : 'POST'])
      expect(mock.unexpected).toEqual([])
    } finally {
      mock.releaseSync.resolve()
    }
  })
}

test('公告校验或保存失败后能重试，成功关闭后能继续新建', async ({ page }) => {
  const mock = await mockNoticeApi(page, { failFirst: true })
  mock.releaseSync.resolve()
  const sheet = await openForm(page, false)
  const submit = sheet.getByTestId('n-submit')
  await sheet.getByTestId('n-title').fill('')
  await submit.click()
  await expect(sheet.getByText('请输入标题', { exact: true })).toBeVisible()
  await expect(submit).toBeEnabled()
  expect(mock.writes).toEqual([])
  await sheet.getByTestId('n-title').fill(notice.title)
  await submit.click()
  await expect(sheet.getByText('回归测试：保存失败', { exact: true })).toBeVisible()
  await expect(submit).toBeEnabled()
  await expect(submit.locator('.animate-spin')).toHaveCount(0)
  await submit.click()
  await expect(sheet).toBeHidden()
  const next = await openForm(page, false, false)
  await expect(next.getByTestId('n-submit')).toBeEnabled()
  await next.getByTestId('n-submit').click()
  await expect(next).toBeHidden()
  expect(mock.writes).toEqual(['POST', 'POST', 'POST'])
  expect(mock.unexpected).toEqual([])
})
