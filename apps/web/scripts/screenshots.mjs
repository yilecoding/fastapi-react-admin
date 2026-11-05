#!/usr/bin/env node
/**
 * 重拍 README / 文档站 / 分享卡片共用的那批截图（`docs/screenshots/*.png`）。
 *
 *     SHOTS_PASSWORD=… pnpm --filter web screenshots
 *
 * 环境（隔离库、造数据）照 apps/docs/AGENTS.md「截图怎么重拍」准备好、前后端都起着，
 * 这个脚本只负责「登录 → 逐页摆好状态 → 拍」。可调的环境变量：
 *
 *   SHOTS_BASE        前端地址，默认 http://127.0.0.1:8888（别用 localhost，见 AGENTS.md）
 *   SHOTS_USER        默认 admin
 *   SHOTS_PASSWORD    必填
 *   SHOTS_CAPTCHA     取验证码答案的命令，`{uuid}` 会被替换；
 *                     默认 docker exec fba_redis redis-cli --raw GET "fba:login:captcha:{uuid}"
 *   SHOTS_ONLY        只拍其中几张，逗号分隔，如 role,dept
 *
 * 🔴 视口 1600×960、**deviceScaleFactor 2**，出图 3200×1920 的真彩 PNG。
 * 原来那批是 1 倍图又压成了 255 色的调色板 PNG：文档站内容列 68rem，在 2 倍屏上要 2176 物理像素，
 * 1600 宽的图被放大 1.36 倍，字边上再叠一层调色板的抖动噪点 —— 看起来就是糊。
 * 别为了省体积再做调色板量化（pngquant / sharp 的 palette），Chromium 出的就是真彩 PNG，原样存。
 *
 * ⚠️ 登录页用 `reducedMotion: 'reduce'` 拍，不用 Playwright 的 `animations: 'disabled'`：
 * 后者把无限循环的动画打回第 0 帧，榫块正好停在离卯最远的地方，看着像两块不相干的方块；
 * 减弱动效下榫卯停在设计好的咬合位（见 apps/web/AGENTS.md「登录页左栏的 3D 榫卯」）。
 */
import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('@playwright/test')

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../../../docs/screenshots')
const BASE = (process.env.SHOTS_BASE ?? 'http://127.0.0.1:8888').replace(/\/$/, '')
const USER = process.env.SHOTS_USER ?? 'admin'
const PASSWORD = process.env.SHOTS_PASSWORD
const CAPTCHA = process.env.SHOTS_CAPTCHA ?? 'docker exec fba_redis redis-cli --raw GET "fba:login:captcha:{uuid}"'
const ONLY = process.env.SHOTS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)

if (!PASSWORD) {
  console.error('缺 SHOTS_PASSWORD（拍图库里那个管理员的密码）')
  process.exit(1)
}

const VIEWPORT = { width: 1600, height: 960 }
const CONTEXT = { viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light', locale: 'zh-CN' }
/** 动画、图表入场、骨架屏都要时间；拍之前统一等这么久 */
const SETTLE_MS = 1500

const want = (name) => !ONLY || ONLY.includes(name)
/** 限定在当前页签里找元素（根 CLAUDE.md 硬纪律 5：隐藏页签的 DOM 还在） */
const tab = (page, route) => page.locator(`[data-tab="/_auth${route}"]`)

async function shoot(page, name) {
  await page.mouse.move(0, VIEWPORT.height - 1)
  await page.waitForTimeout(SETTLE_MS)
  const file = resolve(OUT, `${name}.png`)
  await page.screenshot({ path: file, caret: 'hide' })
  const head = readFileSync(file).subarray(16, 24) // IHDR 里的宽高
  console.log(`  ✓ ${name}.png  ${head.readUInt32BE(0)}×${head.readUInt32BE(4)}`)
}

async function fillLogin(page) {
  await page.getByTestId('username').fill(USER)
  await page.getByTestId('password').fill(PASSWORD)
  const cap = page.getByTestId('captcha')
  if (await cap.count()) {
    await page.waitForFunction(() => document.querySelector('[data-testid="captcha"]')?.getAttribute('data-captcha-uuid'))
    const uuid = await cap.getAttribute('data-captcha-uuid')
    const code = execSync(CAPTCHA.replace('{uuid}', uuid)).toString().trim()
    if (!code) throw new Error(`验证码取不到：${CAPTCHA.replace('{uuid}', uuid)}`)
    await cap.fill(code)
  }
  const login = page.waitForResponse((r) => r.request().method() === 'POST' && /\/auth\/login\b/.test(r.url()))
  await page.getByTestId('submit').click()
  const body = await (await login).json()
  await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'), { timeout: 20_000 })
  return String(body.data.user.id)
}

/**
 * 把功能导览标成看过，不然驱动导览的遮罩盖住整页，点什么都点不动（实测卡在角色列表上 30 秒）。
 * 写法和 e2e/fixtures/base.ts 的 seedTourSeen 一样：合并进 `admin:prefs`，版本号写 999。
 * 写完要整页刷新一次，偏好 store 才会重新读 localStorage。
 */
async function markToursSeen(page, uid) {
  await page.evaluate((id) => {
    const KEY = 'admin:prefs'
    let data = {}
    try { data = JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { data = {} }
    const state = data.state ?? {}
    const seen = { ...(state.toursSeen ?? {}), [`${id}:shell`]: 999 }
    localStorage.setItem(KEY, JSON.stringify({ version: data.version ?? 0, state: { ...state, toursSeen: seen } }))
  }, uid)
  await page.reload()
  await page.waitForLoadState('networkidle')
}

/** 每个上下文自己登录一次：刷新令牌在 cookie 里，跨上下文不共享 */
async function newSession(browser) {
  const ctx = await browser.newContext(CONTEXT)
  const page = await ctx.newPage()
  await page.goto(`${BASE}/sign-in`)
  await markToursSeen(page, await fillLogin(page))
  return { ctx, page }
}

/** 应用内导航（不整页刷新）：已打开的页签保留，和真人点侧边栏一样 */
async function open(page, route) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, route)
  await tab(page, route).waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForLoadState('networkidle')
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
console.log(`拍图：${BASE} → ${OUT}`)

try {
  // 登录页：未登录的干净上下文，填好账号让表单看起来是「正在用」的样子
  if (want('sign-in')) {
    const ctx = await browser.newContext({ ...CONTEXT, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    await page.goto(`${BASE}/sign-in`)
    await page.waitForLoadState('networkidle')
    await page.getByTestId('username').fill(USER)
    await shoot(page, 'sign-in')
    await ctx.close()
  }

  // 工作台这一组共用一个会话：后面几张的页签栏里会依次多出前面打开过的页
  if (['dashboard', 'dept', 'role', 'data-permission', 'workflow-inbox'].some(want)) {
    const { ctx, page } = await newSession(browser)

    await open(page, '/dashboard')
    if (want('dashboard')) await shoot(page, 'dashboard')

    await open(page, '/system/dept')
    if (want('dept')) await shoot(page, 'dept')

    await open(page, '/system/role')
    await tab(page, '/system/role').getByText('普通员工', { exact: true }).first().click()
    await page.waitForLoadState('networkidle')
    if (want('role')) await shoot(page, 'role')

    await open(page, '/system/data-permission')
    await tab(page, '/system/data-permission').getByText('部门及以下数据权限', { exact: true }).first().click()
    await page.waitForLoadState('networkidle')
    if (want('data-permission')) await shoot(page, 'data-permission')

    if (want('workflow-inbox')) {
      await open(page, '/workflow/inbox')
      // 挑那条加急的：详情抽屉里状态、时间线、操作栏都有
      await tab(page, '/workflow/inbox').locator('[data-testid^="wf-row-"]', { hasText: '周敏' }).first().click()
      await page.getByTestId('wf-instance-sheet').waitFor({ state: 'visible' })
      await page.waitForLoadState('networkidle')
      await shoot(page, 'workflow-inbox')
    }
    await ctx.close()
  }

  // 流程设计器单独一个会话：页签栏里只有它自己，画布更干净
  if (want('workflow-designer')) {
    const { ctx, page } = await newSession(browser)
    await open(page, '/workflow/definition')
    const scope = tab(page, '/workflow/definition')
    await scope.getByTestId('wfd-open-LEAVE').click()
    await scope.getByTestId('wfd-designer').waitFor({ state: 'visible' })
    await scope.getByTestId('wfd-step-flow').click()
    await scope.getByTestId('flow-view').getByText('直属主管').first().click()
    await page.waitForLoadState('networkidle')
    await shoot(page, 'workflow-designer')
    await ctx.close()
  }
} finally {
  await browser.close()
}
console.log('拍完了。记得 pnpm --filter @admin/docs og 重新生成分享卡片')
