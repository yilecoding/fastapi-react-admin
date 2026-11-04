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
 * 分四组：
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
 * **组件库自主化那三条**（`packages/ui` 要能被下游整包拿走，见 `packages/ui/PORTING.md`）
 *
 * | 规则 | 级别 | 违反后的表现 |
 * |---|---|---|
 * | 组件既没有生产调用方、也没有沙箱 demo | error | 下家读到它，无从判断「能用的还是没写完的」 |
 * | `dependencies` 里的第三方包源码零引用 | warn | 下一个人以为「这个库我们直接在用」 |
 * | `registry.json` 和源码的 import 图对不上 | error | `shadcn add` 少拷一个文件，下家编译时才炸 |
 *
 * 这三条现在全仓都是干净的，做成闸门是因为**失败方式极难归因**：
 * 违反了不报错，只会「切回这个 tab 时筛选没了」/「测量到的是隐藏页的尺寸」，
 * 而人第一反应永远是去查那个功能本身。每一条都做过反向验证（注入违规 → 红）。
 */

import fs from 'node:fs'
import path from 'node:path'

import { buildRegistry } from './gen-ui-registry.mjs'

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
      // 换行留下：后面报 `file:line` 的规则在剥过注释的文本上数行，吞掉换行行号就整体往上偏
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'
        i += 1
      }
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

// ── 页面外壳：四边 16px 只有一个来源（#209） ──────────────────────────
//
// 内容列（`routes/_auth.tsx` 的 `data-slot="content-scroll"`）给 `p-4`，
// 页面最外层走 `pages/_shared/page-shell.tsx`，**页面自己不写上下 padding**。
//
// 原来三层外壳是每页手抄的，`py-4 md:py-6` 写在第三层 —— 抄漏一层的三页
// （短信日志 / 投递记录 / AI 调用日志）查询区直接贴着标签条，另有五页抄成 `py-3`，
// 全站三种顶距。少 16px 不会让任何测试变红，修过两次都只修了当时那一页。
//
// 三条：
// - `page-shell-handwritten` —— 页面里出现 `@container/main`：说明又在手抄外壳
// - `page-root-padding` —— `*Page` 组件 return 出来的根元素（及其第一层子 div、返回的同文件组件的根）
//   带竖向 padding / 上下 margin
// - `page-root-unscanned` —— 某个 `*Page` 一个根元素都没认出来（扫描器盲区，宁可报错不要假绿）
//
// ⚠️ 只看 `pages/<目录>/index.tsx` 里 `export function XxxPage` 的**每一个** return
// （早退的加载 / 出错分支也算 —— 那几屏同样贴着标签条）。`pages/forbidden.tsx`
// 那种整屏居中的空态不在扫描范围：它的 `py-24` 是居中留白，不是对齐边距。
{
  const PAGES = path.join('packages', 'platform', 'src', 'pages')
  const SHELL = path.join(PAGES, '_shared', 'page-shell.tsx')
  for (const file of tsFiles(PAGES)) {
    if (rel(file) === SHELL) continue
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    if (src.includes('@container/main')) {
      add('error', rel(file), 'page-shell-handwritten', '手写了 @container/main 外壳 —— 用 pages/_shared/page-shell.tsx 的 <PageShell>（#209）')
    }
  }

  // 竖向 padding 和上下 margin 都算（`mt-4` 一样把内容往下推）。`m-auto` / `*-0` 不算
  const VERTICAL = /^-?(?:p|py|pt|pb|m|my|mt|mb)-(?!0$|auto$)\S+$/
  const badTokens = (classes) => {
    const toks = classes.split(/\s+/)
    // 自己画了边框 / 底色的是一张卡片（`EmbeddedPage` 的虚线提示框），padding 在框里面，不挪动它的位置
    const boxed = toks.some((tok) => /^(?:border|bg-)/.test(tok) && !/^border-(?:none|0)$/.test(tok))
    return toks.filter((tok) => {
      const cut = tok.lastIndexOf(':')
      // `[&>section]:py-2` 是给子元素的，不是根元素自己的
      if (cut !== -1 && tok.slice(0, cut).includes('[')) return false
      const base = tok.slice(cut + 1)
      if (boxed && /^-?p/.test(base)) return false
      return VERTICAL.test(base)
    })
  }

  /** 从 `<` 开始读完整个开标签（跳过 `{…}` 和字符串里的 `>`），返回 [标签文本, 结束位置] */
  const openTag = (src, at) => {
    let depth = 0
    let quote = null
    for (let i = at + 1; i < src.length; i += 1) {
      const c = src[i]
      if (quote) {
        if (c === quote) quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') quote = c
      else if (c === '{') depth += 1
      else if (c === '}') depth -= 1
      else if (c === '>' && depth === 0) return [src.slice(at, i + 1), i + 1]
    }
    return [src.slice(at), src.length]
  }

  /** className 里的全部字符串字面量：`"…"` 直接拿；`{cn('…', x && '…')}` 拿里面每一个 */
  const classesOf = (tag) => {
    const m = tag.match(/\bclassName=(?:"([^"]*)"|\{)/)
    if (!m) return ''
    if (m[1] !== undefined) return m[1]
    let depth = 1
    let i = m.index + m[0].length
    for (; i < tag.length && depth > 0; i += 1) {
      if (tag[i] === '{') depth += 1
      else if (tag[i] === '}') depth -= 1
    }
    const expr = tag.slice(m.index + m[0].length, i - 1)
    return [...expr.matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((x) => x[1] ?? x[2] ?? x[3]).join(' ')
  }

  /** 顶格声明的函数组件 → 函数体在 src 里的 [起, 止) */
  const fnBody = (src, name) => {
    const m = new RegExp(`^(?:export )?(?:default )?(?:function ${name}\\b|const ${name}\\s*=)`, 'm').exec(src)
    if (!m) return null
    const end = src.slice(m.index).search(/\n\}\)?;?\n/)
    return [m.index, end === -1 ? src.length : m.index + end]
  }

  /**
   * 一个函数体里「return 出去的根元素」的位置。
   *
   * 判据是缩进：函数体这一层的 return（缩进 2 / 4 = 主 return 和 `if` 里的早退）之后，
   * 根元素是「return 那一行上的 `<`」或者「比 return 深一级的行首 `<`」——
   * 三元的两个分支（`? (` / `) : (`）都落在这一级。更深的是 `.map(…)` 回调里的行 / 卡片，
   * 它们的 padding 是组件自己的（第一版没限缩进，卡片的 `p-4` 全被报成页面根）。
   */
  const rootsIn = (src, [from, to]) => {
    const out = []
    const body = src.slice(from, to)
    for (const r of body.matchAll(/\n( {2,4})return\b/g)) {
      const indent = r[1].length
      const lineStart = from + r.index + 1
      // 缩进 4 的 return 只认 `if` / `else` 里的早退 —— `useMemo(() => { return … })` 这类回调也在这一级
      if (indent > 2) {
        const above = src.slice(from, lineStart).split('\n').reverse()
        const opener = above.find((l) => l.trim() && l.length - l.trimStart().length === indent - 2)
        if (!opener || !/^\s*(?:if\b|\}?\s*else\b)/.test(opener)) continue
      }
      const lineEnd = src.indexOf('\n', lineStart)
      const sameLine = src.slice(lineStart, lineEnd).indexOf('<')
      if (sameLine !== -1) {
        out.push(lineStart + sameLine)
        continue
      }
      // `return renderX()` / `return null`：这一行没开括号就不是多行 JSX，别往下读进别的函数
      if (!/\(\s*$/.test(src.slice(lineStart, lineEnd))) continue
      // 读到和 return 同缩进的那个 `)` 为止
      // 只认单独一行的 `)`：三元的 `) : (` 也在这一级，不能在那儿停
      const close = new RegExp(`\\n {${indent}}\\)\\s*;?\\s*(?=\\n|$)`, 'g')
      close.lastIndex = lineEnd
      const stop = close.exec(src)?.index ?? to
      const child = new RegExp(`\\n {${indent + 2}}<(?!/)`, 'g')
      child.lastIndex = lineEnd
      for (let m = child.exec(src); m && m.index < stop; m = child.exec(src)) out.push(m.index + m[0].length - 1)
    }
    return out
  }

  let roots = 0
  for (const dir of fs.readdirSync(path.join(ROOT, PAGES), { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('_')) continue
    const file = path.join(ROOT, PAGES, dir.name, 'index.tsx')
    if (!fs.existsSync(file)) continue
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    const pages = [...src.matchAll(/^export (?:default )?(?:function|const) (\w+Page)\b/gm)].map((m) => m[1])

    for (const page of pages) {
      let found = 0
      const check = (at, depth) => {
        const [tag, after] = openTag(src, at)
        const name = tag.match(/^<([\w.]*)/)?.[1] ?? ''
        found += 1
        const bad = badTokens(classesOf(tag))
        if (bad.length) {
          add(
            'error',
            `${rel(file)}:${src.slice(0, at).split('\n').length}`,
            'page-root-padding',
            `${page} 的根元素 <${name}> 带了 ${bad.join(' ')} —— 上下左右 16px 由外壳内容列统一给，页面不写（#209）`,
          )
        }
        // 第二层也查：`py-4 md:py-6` 历史上就写在里层 div 上
        if (name === 'div' && depth === 0) {
          const next = src.slice(after).match(/^\s*<div\b/)
          if (next) check(after + next[0].length - 4, 1)
        }
        // `return cond ? <Designer/> : <List/>` —— 同文件里的组件跟进去一层
        if (/^[A-Z]/.test(name) && name !== 'PageShell' && depth === 0) {
          const inner = fnBody(src, name)
          if (inner) for (const r of rootsIn(src, inner)) check(r, 1)
        }
      }
      const own = fnBody(src, page)
      for (const r of own ? rootsIn(src, own) : []) check(r, 0)
      roots += found
      if (!found) {
        add('error', rel(file), 'page-root-unscanned', `${page} 一个根元素都没认出来 —— 扫描器认不了这种写法，补一下 arch-check 的 rootsIn`)
      }
    }
  }
  // 🔴 先断言「有」：一个根元素都没扫到时「没有违规」天然成立
  if (roots < 40) {
    add('error', PAGES, 'page-root-scanner-broken', `只扫到 ${roots} 个页面根元素，扫描器可能坏了`)
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

// ── 自主型组件库：每个组件都得有人真的用过 ────────────────────────────
//
// `packages/ui` 的定位是**被下游整包拿走自己改**（见 `packages/ui/PORTING.md`）。
// 这个定位下，「造了没人用的组件」是最贵的债：下家读到它，无从判断
// 「这是能用的，还是没写完的」—— 而它长得和能用的一模一样。
//
// 实测过一轮：12,646 行里有 2,935 行（≈23%）零调用方，包括一个
// **文档在教人别用**的图表组件（recharts 的 ResponsiveContainer 要测容器宽度，
// 而隐藏页签是 display:none、宽度为 0）和一个和 platform 那份重复、
// 但不支持 async pending 的二次确认框 —— 后者纯粹是个陷阱，
// 下一个人按目录直觉 import 它就中招。
//
// 判据：**生产调用方 或 沙箱 demo，二者必居其一**。
// demo 也算数，因为沙箱就是这个库的目录，而目录本身就是「有人验证过」的证据。
{
  const uiComponents = path.join(ROOT, 'packages/ui/src/components')
  const names = fs.existsSync(uiComponents)
    ? fs.readdirSync(uiComponents, { withFileTypes: true }).flatMap((e) => {
        if (e.isDirectory()) return [e.name]
        return e.name.endsWith('.tsx') ? [e.name.replace(/\.tsx$/, '')] : []
      })
    : []

  // demo 清单：沙箱的 `source:` 字段指向的组件文件
  const demoDir = path.join(ROOT, 'packages/platform/src/pages/dev-sandbox')
  const demoed = new Set()
  for (const file of fs.existsSync(demoDir) ? walk(demoDir).filter((f) => /\.tsx?$/.test(f)) : []) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    for (const m of src.matchAll(/source:\s*'packages\/ui\/src\/components\/([a-z0-9-]+)/g)) {
      demoed.add(m[1])
    }
  }

  // 生产调用方：沙箱和实验台之外的任何 import
  const SANDBOX = [
    path.join('packages', 'platform', 'src', 'pages', 'dev-sandbox'),
    path.join('packages', 'platform', 'src', 'pages', 'playground-table'),
  ]
  const usedInProd = new Set()
  const usedAnywhere = new Set()
  for (const dir of ['packages/platform/src', 'packages/ui/src', 'apps/web/src', 'apps/desktop/src']) {
    for (const file of tsFiles(dir)) {
      const r = rel(file)
      const src = stripComments(fs.readFileSync(file, 'utf8'))
      for (const m of src.matchAll(/@admin\/ui\/components\/([a-z0-9-]+)/g)) {
        // 组件自己 import 自己不算「有人用」
        if (r === path.join('packages', 'ui', 'src', 'components', `${m[1]}.tsx`)) continue
        if (r.startsWith(path.join('packages', 'ui', 'src', 'components', m[1]) + path.sep)) continue
        usedAnywhere.add(m[1])
        if (!SANDBOX.some((sb) => r.startsWith(sb))) usedInProd.add(m[1])
      }
    }
  }

  for (const name of names) {
    if (usedInProd.has(name) || demoed.has(name)) continue
    add(
      'error',
      `packages/ui/src/components/${name}`,
      'orphan-component',
      usedAnywhere.has(name)
        ? `只有沙箱在 import 它、却没有 demo 条目 —— 补一个 demo（source 指向它）或删掉`
        : `既没有生产调用方、也没有沙箱 demo —— 补一个 demo 或删掉，别留给下家判断`,
    )
  }

  // 🔴 先断言「有」：一个组件都扫不到时「没有孤儿」天然成立
  if (names.length < 20) {
    add('error', 'packages/ui/src/components', 'orphan-scanner-broken', `只扫到 ${names.length} 个组件，扫描器可能坏了`)
  }
  if (demoed.size < 20) {
    add('error', demoDir, 'demo-scanner-broken', `只扫到 ${demoed.size} 条 demo 的 source，扫描器可能坏了`)
  }
}

// ── shadcn registry 和源码对不对得上 ──────────────────────────────────
//
// `packages/ui/registry.json` 让下家 `npx shadcn add <url>/data-table`
// 逐个取用组件，依赖自动带上（定位见 `packages/ui/PORTING.md`）。
//
// 它是**生成**的（`pnpm ui:registry`，依赖关系从源码的 import 语句算出来），
// 做成闸门是因为漂移方式是静默的：加一个组件、改一处 import，清单不会自己跟上，
// 而 `shadcn add` 照常成功、只是少拷了一个文件 —— 下家那边编译时才炸，
// 报的是「找不到 ./checkbox」，跟 registry 八竿子打不着。
{
  const registryPath = path.join(ROOT, 'packages/ui/registry.json')
  if (!fs.existsSync(registryPath)) {
    add('error', 'packages/ui/registry.json', 'missing-registry', '文件不在了 —— 跑 `pnpm ui:registry`')
  } else {
    const want = `${JSON.stringify(buildRegistry(), null, 2)}\n`
    if (fs.readFileSync(registryPath, 'utf8') !== want) {
      add('error', 'packages/ui/registry.json', 'stale-registry', '和源码对不上了 —— 跑 `pnpm ui:registry` 重新生成')
    }
  }
}

// ── 第三方死声明 ──────────────────────────────────────────────────────
//
// 上面那条 `unused-declaration` 只查 `@admin/*` 开头的，所以
// `date-fns` 这种第三方死声明查不到 —— 实测就漏过一条：源码零引用，
// 它其实是 `react-day-picker` 自己的依赖，我们这条声明纯属误加。
//
// 死声明的代价不只是多装一个包：下一个人读 `dependencies` 时会以为
// 「这个库我们直接在用」，于是照着它写新代码，而它随时可能被清掉。
//
// ⚠️ 只查**运行时**依赖，不查 devDependencies —— 工具链的包（eslint 插件、
// tailwind、类型包）本来就不该在源码里出现，那不是死声明。
{
  //: 不会在源码里 import、但确实在用的运行时依赖。
  //
  //  ⚠️ 往这里加之前先想清楚**它凭什么是运行时依赖** —— 理由写在旁边。
  //  这个豁免表长得越快，这条规则越没用。
  const RUNTIME_ONLY = {
    'packages/ui': new Set([
      // CSS 入口 import 的，不走 JS
      'tw-animate-css',
      'shadcn',
      '@fontsource-variable/inter',
      '@fontsource-variable/jetbrains-mono',
      // Tiptap 的 ProseMirror 底座，由 @tiptap/react 要求显式安装
      '@tiptap/pm',
    ]),
    'apps/mobile': new Set([
      // Expo 的**自动链接**原生模块 —— 装了就生效，不需要（也不该）在 JS 里 import。
      // expo-router 的文档把这几个列为必装项
      'expo-constants',
      'expo-font',
      'expo-linking',
      'expo-system-ui',
      'react-native-gesture-handler',
      'react-native-screens',
      // react-native-reanimated 的运行时，由 Babel 插件在编译期注入调用
      'react-native-worklets',
    ]),
  }

  for (const pkgDir of PACKAGES) {
    const abs = path.join(ROOT, pkgDir)
    const pkgJson = readJson(path.join(abs, 'package.json'))
    const deps = Object.keys(pkgJson.dependencies ?? {}).filter((d) => !d.startsWith('@admin/'))
    if (!deps.length) continue

    const allowed = RUNTIME_ONLY[pkgDir] ?? new Set()
    const srcDir = path.join(abs, 'src')
    let blob = ''
    for (const file of fs.existsSync(srcDir)
      ? walk(srcDir).filter((f) => /\.(ts|tsx|js|jsx|mjs|css)$/.test(f))
      : []) {
      blob += fs.readFileSync(file, 'utf8')
    }
    // 配置文件也算（vite.config.ts 里 import 的插件是真在用）
    for (const name of fs.readdirSync(abs).filter((f) => /^(vite|tailwind|postcss|metro|app)\..*\.(ts|js|mjs|json)$/.test(f))) {
      blob += fs.readFileSync(path.join(abs, name), 'utf8')
    }

    for (const dep of deps) {
      if (allowed.has(dep)) continue
      // `from 'x'` / `from 'x/sub'` / `import('x')` / `@import "x"` 都算
      const esc = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`['"\`]${esc}(?:/|['"\`])`).test(blob)) continue
      add('warn', `${pkgDir}/package.json`, 'unused-third-party', `声明了 ${dep} 但源码里没有一处引用它`)
    }
  }
}

// ── 生产镜像：安装依赖前拷的清单要覆盖 web 的整条 workspace 依赖链（#233）─────────
//
// `apps/web/Dockerfile` 先只拷各包的 package.json、`pnpm install --filter web...`，再 `COPY . .`。
// 漏拷哪个 workspace 包的清单，pnpm 在安装那一刻就看不见它 —— 它自己的第三方依赖一个都不装，
// 而 `COPY . .` 之后源码又在，所以不一定当场炸：`@admin/api` 就这样漏了很久（推断：web 恰好只用到它
// 不需要运行时依赖的导出）。和本文件开头那次事故同一类：一直是绿的，直到多 import 一个东西。
{
  const dockerfile = path.join(ROOT, 'apps/web/Dockerfile')
  const src = fs.readFileSync(dockerfile, 'utf8')
  const installAt = src.search(/^RUN\b[^\n]*\n?(?:[^\n]*\\\n)*[^\n]*pnpm install/m)
  const head = installAt < 0 ? src : src.slice(0, installAt)
  const copied = new Set([...head.matchAll(/^COPY\s+(\S+)\/package\.json\b/gm)].map((m) => m[1]))
  if (installAt < 0) {
    add('error', 'apps/web/Dockerfile', 'dockerfile-unparseable', '找不到 pnpm install 那一步，无法核对拷了哪些清单')
  }

  const dirOf = new Map(PACKAGES.map((d) => [readJson(path.join(ROOT, d, 'package.json')).name, d]))
  const closure = new Set()
  const visit = (dir) => {
    if (closure.has(dir)) return
    closure.add(dir)
    const pj = readJson(path.join(ROOT, dir, 'package.json'))
    for (const [name, spec] of Object.entries({ ...pj.dependencies, ...pj.devDependencies })) {
      if (String(spec).startsWith('workspace:') && dirOf.has(name)) visit(dirOf.get(name))
    }
  }
  visit('apps/web')
  // 先断言「有」：闭包里至少要有 platform，否则是解析坏了，「全都拷了」会假绿
  if (!closure.has('packages/platform')) {
    add('error', 'apps/web/Dockerfile', 'dockerfile-closure-empty', 'web 的 workspace 依赖链里没算出 packages/platform，核对逻辑坏了')
  }
  for (const dir of closure) {
    if (!copied.has(dir)) {
      add('error', 'apps/web/Dockerfile', 'dockerfile-missing-manifest',
        `pnpm install 之前没拷 ${dir}/package.json —— --filter web... 的裁剪范围里看不见它，它的依赖不会装`)
    }
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
  `\n依赖箭头 ${PACKAGES.length} 个包 · 多页签三条纪律 · 页面外壳三条 · 功能引导两条 · 组件孤儿 · registry · 品牌版本 · E2E 断言 · 镜像清单 · 错误 ${errors.length} · 警告 ${warns.length}`,
)
if (!problems.length) console.log('[ok] 没有漂')
process.exit(errors.length ? 1 : 0)
