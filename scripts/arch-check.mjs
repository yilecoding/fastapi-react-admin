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
  `\n依赖箭头 ${PACKAGES.length} 个包 · 多页签三条纪律 · 品牌版本 · 错误 ${errors.length} · 警告 ${warns.length}`,
)
if (!problems.length) console.log('[ok] 没有漂')
process.exit(errors.length ? 1 : 0)
