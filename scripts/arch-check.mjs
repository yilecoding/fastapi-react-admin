#!/usr/bin/env node
/**
 * arch:check —— 核对依赖箭头有没有漂。
 *
 * CLAUDE.md 的结构一节写着一条硬纪律：
 *
 *   🔴 这个箭头必须同时体现在 `package.json` 的 `dependencies` 里，
 *      不能只体现在 `vite.config.ts` 的 alias / `tsconfig` 的路径映射上。
 *
 * 那条纪律是被**一次生产构建事故**换来的：`apps/web` 的代码 import
 * `@admin/platform`、alias 也配了，但 `package.json` 里没有它。日常的整仓
 * `pnpm install` 会把所有工作区包的依赖一起装上，所以**一直是绿的** ——
 * 直到 `apps/web/Dockerfile` 那条 `pnpm install --filter web...` 第一次在
 * 干净环境里跑：裁剪范围里压根没有 platform，`tsc -b` 成片
 * `Cannot find module 'react'`。
 *
 * 「一直是绿的，直到某个地方第一次做 scoped install」正是**能被机器核对**的
 * 那种断言 —— 和 `ctx:check` / `i18n:check` 同一个物种，所以做成闸门。
 *
 * 两组共七条：
 *
 * **依赖箭头**（本文件上半）
 *
 * | 规则 | 级别 | 为什么 |
 * |---|---|---|
 * | import 了就必须声明 | error | 上面那次事故 |
 * | tsconfig paths 映射了就必须声明 | error | 事故的**上游**：漂移从这里开始 |
 * | 箭头方向不能反 | error | `ui → platform` 之类会把分层吃穿 |
 * | 声明了但没人 import | warn | 死声明会误导下一个读箭头的人 |
 *
 * **多页签那三条硬纪律**（本文件下半，全是 error）
 *
 * | 规则 | 硬纪律 | 违反后的表现 |
 * |---|---|---|
 * | 页面组件不读路由 | 1 | 隐藏 tab 拿不到 match 上下文 |
 * | `_auth/` 下的路由文件不渲染页面 | 3 | 页面被挂两次 / 切走丢状态 |
 * | 全局 DOM 查询要限定作用域 | 5 | 命中隐藏页的 DOM |
 *
 * **功能引导那两条**（硬纪律 5 的延伸，见 `shell/tour/targets.ts` 头注释）
 *
 * | 规则 | 违反后的表现 |
 * |---|---|
 * | `driver.js` 只能在 `shell/tour/` 里 import | 裸选择器字串绕过上面那条 DOM 规则，命中隐藏页签 |
 * | 步骤引用的 `data-tour` 目标必须存在 | 那一步凭空消失（或变成居中的空弹窗），没有任何报错 |
 *
 * 这三条现在全仓都是干净的，做成闸门是因为**失败方式极难归因**：
 * 违反了不报错，只会「切回这个 tab 时筛选没了」/「测量到的是隐藏页的尺寸」，
 * 而人第一反应永远是去查那个功能本身。七条全部做过反向验证（注入违规 → 红）。
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** 参与核对的包。`apps/api` / `apps/worker` 是 Python，只有一个 dev 脚本、零 JS 依赖 */
const PACKAGES = [
  'apps/web',
  'apps/mobile',
  'apps/desktop',
  'packages/platform',
  'packages/ui',
  'packages/i18n',
  'packages/api',
]

/**
 * 不允许存在的箭头。左边不能依赖右边。
 *
 * 依据 CLAUDE.md：`i18n` / `api` ← `ui` ← `platform` ← `apps/web`，
 * 而 `apps/mobile` 直接依赖那两个最底层包、**不经过 platform**
 * （platform 是 web 形状的：TanStack Router、react-dom、socket.io）。
 */
const FORBIDDEN = {
  '@admin/i18n': ['@admin/api', '@admin/ui', '@admin/platform'],
  '@admin/api': ['@admin/i18n', '@admin/ui', '@admin/platform'],
  '@admin/ui': ['@admin/platform'],
  '@admin/platform': [],
}

const problems = []
const add = (level, where, rule, msg) => problems.push({ level, where, rule, msg })

const walk = (dir) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name)
        if (e.name === 'node_modules') return []
        return e.isDirectory() ? walk(p) : [p]
      })
    : []

/**
 * 剥掉注释 —— 否则「不要 import xxx」这种说明文字会被当成真的 import。
 *
 * 🔴 **必须字符串感知，不能用正则。** 第一版就是两条正则，结果把字符串里的
 * glob 当成了块注释开头：`"@/*"` 里那两个字符一开，就一路吃到下一个块注释
 * 结束符（`include` 里某个 `.ts` glob 里就有），把 JSON 啃成碎片。
 *
 * 而它的表现是「解析不了 → 跳过这个文件」—— 检查**静默地**停止覆盖两个包，
 * 报告照旧显示通过。正是这个闸门要治的那种漂移。
 */
const stripComments = (src) => {
  let out = ''
  let quote = null
  let escaped = false
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (quote) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = null
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

/** 去掉尾逗号（`}` / `]` 之前的那个），同样只在字符串之外动手 */
const stripTrailingCommas = (src) => {
  let out = ''
  let quote = null
  let escaped = false
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (quote) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      continue
    }
    if (c === ',') {
      const rest = src.slice(i + 1)
      const next = rest.match(/^\s*([}\]])/)
      if (next) continue
    }
    out += c
  }
  return out
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

for (const pkgDir of PACKAGES) {
  const abs = path.join(ROOT, pkgDir)
  const pkgJson = readJson(path.join(abs, 'package.json'))
  const self = pkgJson.name

  const declared = new Set(
    Object.keys({ ...pkgJson.dependencies, ...pkgJson.devDependencies }).filter((d) => d.startsWith('@admin/')),
  )

  // ── 源码里真正 import 了谁 ────────────────────────────────────────────
  const imported = new Set()
  for (const file of walk(path.join(abs, 'src')).filter((f) => /\.(ts|tsx|js|jsx|mjs)$/.test(f))) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/from\s+['"](@admin\/[a-z0-9-]+)|import\s*\(\s*['"](@admin\/[a-z0-9-]+)/g)) {
      imported.add(m[1] ?? m[2])
    }
  }

  // ⚠️ 自引用要放行：`packages/ui` 里到处 `import { cn } from '@admin/ui/lib/utils'`。
  // 那是 Node 标准的**包自引用**（靠 package.json 的 `exports` 字段），
  // 不需要、也不该声明自依赖。实测确认过 ui 有 exports。
  imported.delete(self)

  for (const dep of imported) {
    if (!declared.has(dep)) {
      add('error', pkgDir, 'undeclared-import', `import 了 ${dep} 但 package.json 里没有它`)
    }
  }

  // ── tsconfig 的路径映射 ──────────────────────────────────────────────
  // 这是漂移的**上游**：先加映射让它跑起来，再忘了同步 package.json。
  for (const name of ['tsconfig.json', 'tsconfig.app.json']) {
    const tsPath = path.join(abs, name)
    if (!fs.existsSync(tsPath)) continue
    // tsconfig 允许注释和尾逗号，先清掉
    const raw = stripTrailingCommas(stripComments(fs.readFileSync(tsPath, 'utf8')))
    let paths = {}
    try {
      paths = JSON.parse(raw).compilerOptions?.paths ?? {}
    } catch (e) {
      // 🔴 解析失败算**错误**，不是警告。「解析不了就跳过」等于让检查静默地
      // 停止覆盖这个包 —— 而报告照旧显示通过。宁可炸，也不要假绿。
      add('error', `${pkgDir}/${name}`, 'unparseable-tsconfig', `解析不了，无法核对路径映射：${e.message}`)
      continue
    }
    for (const key of Object.keys(paths)) {
      const dep = key.match(/^(@admin\/[a-z0-9-]+)/)?.[1]
      if (!dep || dep === self || declared.has(dep)) continue
      add('error', `${pkgDir}/${name}`, 'undeclared-path-mapping', `paths 里映射了 ${dep} 但 package.json 里没有它`)
    }
  }

  // ── 方向 ────────────────────────────────────────────────────────────
  for (const dep of declared) {
    if (FORBIDDEN[self]?.includes(dep)) {
      add('error', pkgDir, 'wrong-direction', `${self} 不能依赖 ${dep} —— 箭头是单向的，见 CLAUDE.md 的结构一节`)
    }
  }

  // ── 声明了但没人用 ──────────────────────────────────────────────────
  for (const dep of declared) {
    if (!imported.has(dep)) {
      add('warn', pkgDir, 'unused-declaration', `声明了 ${dep} 但源码里没有一处 import 它`)
    }
  }
}

// ── 硬纪律 1 / 3 / 5：多页签那三条 ────────────────────────────────────
//
// 这三条现在全仓都是干净的，所以它们是**回归守卫**，不是在抓存量问题。
// 值得做成闸门是因为**失败方式极难归因**：违反了不会报错，
// 只会「切回这个 tab 时筛选条件没了」/「测量到的是隐藏页的尺寸」，
// 而人第一反应永远是去查那个功能本身。

const tsFiles = (dir) => walk(path.join(ROOT, dir)).filter((f) => /\.(ts|tsx)$/.test(f))
const rel = (f) => path.relative(ROOT, f)

// 硬纪律 1：平台页面组件必须 router-独立
//
// `<Activity>` 同时挂载所有已打开的 tab，但 router 只有一个 location 是
// 「匹配」的 —— 隐藏 tab 拿不到 match 上下文。params / search 只能走 props。
for (const file of tsFiles('packages/platform/src/pages')) {
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  for (const m of src.matchAll(/Route\.use(?:Search|Params)\s*\(|\buseNavigate\s*\(/g)) {
    add('error', rel(file), 'page-reads-router', `页面组件里出现了 ${m[0].trim()} —— 见硬纪律 1，params / search 只能走 props`)
  }
}

// 硬纪律 3：路由文件不渲染页面
//
// ⚠️ 只管 `routes/_auth/` **目录下**的（走 TabOutlet 那些）。
// `routes/_auth.tsx` 本身是布局、`__root.tsx` / `_guest/**` 在多页签体系之外，
// 它们渲染组件是对的 —— 第一版路径判断用 `includes('routes/_auth')`，
// 把布局文件也框进来了。
for (const file of tsFiles('apps/web/src/routes')) {
  if (!rel(file).includes(`routes${path.sep}_auth${path.sep}`)) continue
  const src = stripComments(fs.readFileSync(file, 'utf8'))
  const m = src.match(/component:\s*([^,\n]*)/)
  if (m && !/\(\)\s*=>\s*null/.test(m[1])) {
    add('error', rel(file), 'route-renders-page', `component 是 ${m[1].trim()} —— 见硬纪律 3，路由文件只声明守卫，页面由 TabOutlet 挂`)
  }
}

// 硬纪律 5：全局 DOM 查询必须限定作用域
//
// 隐藏 tab 的 DOM **仍在文档树里**，`document.querySelector` 会命中它们。
// 按 routeId 锁（`[data-tab="..."]`）比按可见性锁（`[data-visible="true"]`）更稳 ——
// 切 tab 时有一段窗口两个 frame 都是 `true`（实测 ~18ms，整页加载后 ~300ms）。
const DOM_QUERY_ALLOWLIST = new Set([
  // React 挂载点。跑在任何 tab 存在之前，而且 `#root` 全文档唯一
  path.join('apps', 'web', 'src', 'main.tsx'),
])
for (const dir of ['packages/platform/src', 'packages/ui/src', 'apps/web/src', 'apps/web/e2e']) {
  for (const file of tsFiles(dir)) {
    if (DOM_QUERY_ALLOWLIST.has(rel(file))) continue
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    // 连着实参一起抓，才能判断有没有限定作用域
    for (const m of src.matchAll(/document\.(querySelector|querySelectorAll|getElementById|getElementsBy\w+)\s*\(([^)]*)\)/g)) {
      if (/data-visible|data-tab/.test(m[2])) continue
      add(
        'error',
        rel(file),
        'unscoped-dom-query',
        `document.${m[1]} 没限定作用域 —— 见硬纪律 5，隐藏 tab 的 DOM 也在文档树里，按 [data-tab="<routeId>"] 锁`,
      )
    }
  }
}

// ── 功能引导：tour 库不出 shell/tour/、目标标记不能是死的 ─────────────────
//
// driver.js 对字符串目标是 `document.querySelector(e)`，发生在 node_modules 里 ——
// 上面的 `unscoped-dom-query` 看不见。所以把库锁在一个目录里，那个目录的 `targets.ts`
// 只暴露函数形态的目标（类型上传不了字串），并且它自己的查询都带 `data-tab` 作用域。
const TOUR_DIR = path.join('packages', 'platform', 'src', 'shell', 'tour')
for (const dir of ['packages/platform/src', 'packages/ui/src', 'apps/web/src']) {
  for (const file of tsFiles(dir)) {
    if (rel(file).startsWith(TOUR_DIR)) continue
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    if (/from\s+['"]driver\.js/.test(src) || /import\s*\(\s*['"]driver\.js/.test(src)) {
      add('error', rel(file), 'tour-lib-outside-tour-dir', `import 了 driver.js —— 只能在 ${TOUR_DIR}/ 里 import，别处拿 startTour() / TourDef`)
    }
  }
}

// 步骤里 `inShell('x')` / `inTab(key, 'x')` 引用的 id，源码里必须有对应的 `data-tour="x"`。
// 和 ctx:check 的 dead-testid 同一物种：目标标记被改名 / 删掉后导览照样「跑」，
// 只是那一步没了（`resolveSteps` 会把它过滤掉），typecheck / lint / E2E 全绿。
{
  const referenced = new Map() // id -> 首个引用处
  for (const file of tsFiles('packages/platform/src')) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/\binShell\(\s*['"]([^'"]+)['"]/g)) referenced.set(m[1], referenced.get(m[1]) ?? rel(file))
    for (const m of src.matchAll(/\binTab\([^,]+,\s*['"]([^'"]+)['"]/g)) referenced.set(m[1], referenced.get(m[1]) ?? rel(file))
  }
  const defined = new Map() // id -> 首个定义处
  for (const dir of ['packages/platform/src', 'packages/ui/src', 'apps/web/src']) {
    for (const file of tsFiles(dir)) {
      const src = stripComments(fs.readFileSync(file, 'utf8'))
      for (const m of src.matchAll(/data-tour=\{?['"]([^'"]+)['"]/g)) defined.set(m[1], defined.get(m[1]) ?? rel(file))
    }
  }
  for (const [id, where] of referenced) {
    if (!defined.has(id)) add('error', where, 'dead-tour-target', `导览步骤引用了 data-tour="${id}"，但源码里没有这个标记 —— 那一步会静默消失`)
  }
  for (const [id, where] of defined) {
    if (!referenced.has(id)) add('warn', where, 'unused-tour-target', `data-tour="${id}" 没有任何导览步骤引用它`)
  }
  // 🔴 先断言「有」：一条引用都扫不到时「没有死目标」天然成立
  if (referenced.size === 0) add('error', TOUR_DIR, 'tour-scanner-broken', '没扫到任何 inShell() / inTab() 引用，扫描器可能坏了')
}

// ── 品牌信息：版本号不能写死 ──────────────────────────────────────────
//
// `apps/web/src/lib/brand.ts` 的开头写着「改名字、改版本只动这里」，
// 而 `version` 原来手写着 `"v0.0.1"` —— 和 `apps/web/package.json` 的 `0.0.1`
// 是**两份真相源**。bump 了包版本忘了改它，登录页和页脚就长期显示旧版本，
// 而没有任何东西会发现（没人比对过这两个数）。
//
// 现在版本从 `package.json` 注入（`VITE_APP_VERSION`），实测 bump 成 9.9.9
// 产物里就是 `v9.9.9`。这条守卫防的是有人再把它写死回去。
{
  const brandPath = path.join(ROOT, 'apps/web/src/lib/brand.ts')
  if (fs.existsSync(brandPath)) {
    const src = stripComments(fs.readFileSync(brandPath, 'utf8'))
    const hardcoded = src.match(/version:\s*['"`](v?\d+\.\d+\.\d+)/)
    if (hardcoded) {
      add(
        'error',
        'apps/web/src/lib/brand.ts',
        'hardcoded-version',
        `version 写死成了 ${hardcoded[1]} —— 它必须来自 package.json（VITE_APP_VERSION）`,
      )
    }
  } else {
    add('error', 'apps/web/src/lib/brand.ts', 'missing-brand', '文件不在了，这条守卫已经罩不住了')
  }
}

// ── E2E：Playwright 的 web-first 断言不能漏 await ─────────────────────
//
// `expect(locator).toBeVisible()` 返回 promise。漏了 `await`，这条断言
// **压根不执行** —— 测试照旧绿，而它什么都没验。这是 Playwright 最经典的
// 静默失效，比选择器写错更难发现（选择器错了至少会超时报错）。
//
// ⚠️ **eslint 在这个仓库里管不了它。** `@typescript-eslint/no-floating-promises`
// 需要 type-aware linting（`projectService` / `parserOptions.project`），
// 而 `apps/web/eslint.config.js` 没配 —— 开它要付整仓 lint 的时间代价。
// 这条静态检查便宜得多，覆盖的正是这一个形状。
//
// 实测基线：128 处 web-first 断言，0 处漏 await。这条守的是「保持 0」。
{
  //: Playwright 的 web-first 匹配器 —— 这些返回 promise，必须 await
  const WEB_FIRST = [
    'toBeVisible', 'toBeHidden', 'toHaveText', 'toContainText', 'toHaveCount',
    'toHaveValue', 'toHaveURL', 'toHaveTitle', 'toBeEnabled', 'toBeDisabled',
    'toBeChecked', 'toHaveAttribute', 'toHaveClass', 'toBeEmpty', 'toBeFocused',
    'toBeEditable', 'toHaveScreenshot', 'toPass',
  ]
  const e2eDir = path.join(ROOT, 'apps/web/e2e')
  let checked = 0
  if (fs.existsSync(e2eDir)) {
    for (const file of walk(e2eDir).filter((f) => f.endsWith('.ts'))) {
      const src = stripComments(fs.readFileSync(file, 'utf8'))
      const lines = src.split('\n')
      for (const m of src.matchAll(/\bexpect\s*\(/g)) {
        // 🔴 **必须定位到「这一个 expect 调用自己的匹配器」**，不能往后看几行。
        //
        // 第一版是 `lines.slice(index, index + 4)` 里找 web-first 匹配器 ——
        // 结果把 `expect(dirs.length, '...').toBeGreaterThan(0)` 报成违规
        // （合并 main 的新 e2e 用例时当场撞到）：`toBeGreaterThan` 是**同步**
        // 匹配器、压根不需要 await，只是它下面几行恰好有个 `toBeVisible()`。
        //
        // 现在从 `expect(` 开始数括号找到这次调用的结尾，只看紧跟其后的那个
        // `.xxx(`（允许中间夹 `.not` / `.resolves` / 换行）。
        let i = m.index + m[0].length - 1
        let depth = 0
        while (i < src.length) {
          if (src[i] === '(') depth += 1
          else if (src[i] === ')') {
            depth -= 1
            if (depth === 0) break
          }
          i += 1
        }
        const tail = src.slice(i + 1, i + 200)
        const matcher = tail.match(/^\s*(?:\.(?:not|resolves|rejects)\s*)*\.\s*(\w+)\s*\(/)
        if (!matcher || !WEB_FIRST.includes(matcher[1])) continue

        checked += 1
        const lineNo = src.slice(0, m.index).split('\n').length
        const line = lines[lineNo - 1] ?? ''
        const before = src.slice(Math.max(0, m.index - 200), m.index)
        const awaited = /\b(await|return)\s*$/.test(before) || /\bawait\b[^\n;]*$/.test(before.split('\n').pop() ?? '')
        if (!awaited) {
          add(
            'error',
            `${rel(file)}:${lineNo}`,
            'unawaited-assertion',
            `web-first 断言漏了 await，这条断言不会执行：${line.trim().slice(0, 80)}`,
          )
        }
      }
    }
  }
  // 🔴 先断言「有」：扫不到任何断言时「没有漏 await」天然成立
  if (checked < 50) {
    add('error', 'apps/web/e2e', 'e2e-scanner-broken', `只扫到 ${checked} 处 web-first 断言，扫描器可能坏了`)
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────
const errors = problems.filter((p) => p.level === 'error')
const warns = problems.filter((p) => p.level === 'warn')

const byWhere = new Map()
for (const p of problems) {
  if (!byWhere.has(p.where)) byWhere.set(p.where, [])
  byWhere.get(p.where).push(p)
}
for (const [where, ps] of byWhere) {
  console.log(`\n${where}`)
  for (const p of ps) console.log(`  ${p.level === 'error' ? '✗' : '!'} [${p.rule}] ${p.msg}`)
}

console.log(
  `\n依赖箭头 ${PACKAGES.length} 个包 · 多页签三条纪律 · 功能引导两条 · 品牌版本 · E2E 断言 · 错误 ${errors.length} · 警告 ${warns.length}`,
)
if (!problems.length) console.log('[ok] 没有漂')
process.exit(errors.length ? 1 : 0)
