#!/usr/bin/env node
/**
 * 上下文文件漂移校验器 —— 和 `i18n:check` 同一个物种。
 *
 * 为什么需要它：根 CLAUDE.md 是**踩坑记录**，全是「实测出来的结论」。
 * 结论会过期，而过期的方式是**静默**的 —— 它照旧言之凿凿地指着一个
 * 已经不存在的文件。实测样本：CLAUDE.md 教了很久「别用 `command.tsx`」，
 * 而那个文件早就删了；下一个人（或下一个 agent）会照着一条关于不存在
 * 的东西的规矩去做判断。
 *
 * 所以：凡是能被机器核对的断言，就让机器核对。
 *
 * 用法：pnpm ctx:check          （有 error 退出码 1）
 *      pnpm ctx:check --quiet  （只打错误）
 *
 * 规则见 `scripts/AGENTS.md`。加规则时**先造一个反例验证它会红** ——
 * 一条永远不报的检查和没有这条检查是一回事。
 */
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QUIET = process.argv.includes('--quiet')

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.venv', '.turbo',
  '.pytest_cache', '.ruff_cache', 'upload', 'upload-public', '.schemas',
])

/** 行数预算：超了就是「这个文件该拆了」的信号，不是硬错误 */
const BUDGET = { 'CLAUDE.md': 400, default: 500 }

// ── 扫仓库 ────────────────────────────────────────────────────────────
const allFiles = []
;(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue
    if (IGNORE_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else allFiles.push(relative(ROOT, p).replaceAll('\\', '/'))
  }
})(ROOT)

const fileSet = new Set(allFiles)
const byBasename = new Map()
for (const f of allFiles) {
  const b = f.split('/').pop()
  if (!byBasename.has(b)) byBasename.set(b, [])
  byBasename.get(b).push(f)
}
const dirSet = new Set(allFiles.flatMap((f) => {
  const parts = f.split('/'); const out = []
  for (let i = 1; i < parts.length; i += 1) out.push(parts.slice(0, i).join('/') + '/')
  return out
}))

/** 所有源码拼一起，用来核对 testid / 权限码 / 符号是否真的存在 */
// `sh` 在列表里是因为 deploy/ 的「源码」就是一个 shell 脚本 —— 少了它
// `empty-scope` 会把 deploy/AGENTS.md 判成「模块被搬走了」，而那是误报
const SRC_EXT = /\.(tsx?|jsx?|mjs|py|css|json|sql|toml|sh)$/
const srcBlob = allFiles
  .filter((f) => SRC_EXT.test(f) && !f.endsWith('.md'))
  .map((f) => { try { return readFileSync(join(ROOT, f), 'utf8') } catch { return '' } })
  .join('\n')

/** 所有 package.json 里的脚本名 */
const scripts = new Set()
for (const f of allFiles.filter((f) => f.endsWith('package.json'))) {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, f), 'utf8'))
    for (const k of Object.keys(pkg.scripts ?? {})) scripts.add(k)
  } catch { /* 坏的 package.json 不是这个脚本的职责 */ }
}

// ── 收集上下文文件 ────────────────────────────────────────────────────
const ctxFiles = allFiles
  /*
   * 🔴 **不只是 `CLAUDE.md` / `AGENTS.md`。**
   *
   * 原来只扫那两种，于是 `README.md` / `CONTRIBUTING.md` / PR 模板**完全不在
   * 覆盖范围** —— 而它们含的是同一类机器可核对的断言（脚本名、文件路径、
   * 相对链接）。实测：一次人工梳理从这三个文件里翻出 `pnpm --filter web build`
   * 已被硬纪律否掉、Playwright 条数停在 44（实际 54）、闸门清单少两道门。
   * 打开覆盖之后全仓只多出 **2 条**存量（见下面 ALLOW 里那两条），几乎零成本。
   *
   * `PORTING.md` 是同一个理由加进来的：它整篇都在报路径和依赖名
   * （「拷 `src/lib/i18n.ts`」「删掉 `@tiptap/*`」），而它面向的是
   * **拿走这个包的下家** —— 指错一个路径的代价比内部文档还高。
   */
  .filter((f) => /(^|\/)(CLAUDE|AGENTS|README|CONTRIBUTING|SECURITY|PORTING|PULL_REQUEST_TEMPLATE)\.md$/.test(f))
  // 每个模块目录下是 AGENTS.md（真身）+ CLAUDE.md（符号链接），
  // 不去重的话同一条问题会报两遍
  .filter((f) => !lstatSync(join(ROOT, f)).isSymbolicLink())

/**
 * 豁免表：文档提到这些东西**正是因为它们不存在**（已删除 / 刻意不用 /
 * 运行时才生成）。登记时必须写理由 —— 没理由的豁免下次就没人敢删了。
 */
const ALLOW = new Map(Object.entries({
  'README.zh-CN.md': 'apps/api/README.md 里那句话正是在说「上游这几个文件已经删掉」',
  'CHANGELOG.md': '同上 —— 上游 FBA 的 changelog，分叉里刻意不留',
  'versions/': 'alembic 迁移目录，文档说的就是「它是空的」',
  'backend/upload/': '运行时创建的上传目录，不进 git',
  'backend/upload-public/': '同上，公开子树',
  'storageState.json': 'Playwright 的概念，文档说的就是「这条路走不通」',
  'settings-layout.tsx': '已被 settings-shell.tsx 取代，文档在讲换掉它的理由',
  'command.tsx': 'cmdk 封装，零调用方已连依赖链一起删除；文档在讲「不要把它引回来」',
  'version.json': '构建产物（vite 发到 dist 根目录），不进 git',
  'latest.yml': 'electron-builder 的产物（更新清单），不进 git',
  'latest-mac.yml': '同上，macOS 的更新清单',
  'latest-linux.yml': '同上，Linux 的更新清单',
  'app-update.yml': '同上，打包时写进安装包的 resources/',
  'userData/config.json': '桌面端运行期在用户目录生成的配置',
  'config.json': '同上',
  'resources/': '桌面端放原生助手的目录，仓库里只有一个 .gitkeep —— 而这个扫描器跳过点开头的文件',
  'release.yml': '在 .github/ 下，而这个扫描器刻意跳过点开头的目录',
  '.pre-commit-config.yaml': '在仓库里，真实存在（`git ls-files` 能看到）——但这个扫描器刻意跳过点开头的文件，只是巧合命中',
  'apps/api/.pre-commit-config.yaml': '同上，带路径前缀引用时是另一个 token，一起豁免',
  'scripts/deploy-prod.mjs': '已被 deploy/prod.sh 取代（它假设部署机上有整个仓库）；文档在讲这个假设为什么不成立',
  'driver.js': 'npm 包名（功能引导用的 tour 库），不是仓库里的路径 —— 只是长得像文件名',
}))

/** 章节标题 → 所在上下文文件。用来判「见「XXX」」指的那一节还在不在、在不在同一份 */
const sectionOwner = new Map()
for (const f of ctxFiles) {
  for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/^#{1,4} (.+)$/gm)) {
    const title = m[1].trim()
    if (!sectionOwner.has(title)) sectionOwner.set(title, [])
    sectionOwner.get(title).push(f)
  }
}
/** 「见「主从页」」这种引用是子串匹配的 —— 标题常带补充说明（「查询区（QueryBar · …）」） */
function ownersOf(ref) {
  const out = new Set()
  for (const [title, fs] of sectionOwner) if (title.includes(ref)) for (const f of fs) out.add(f)
  return [...out]
}

const problems = []
const add = (level, file, line, rule, msg) => problems.push({ level, file, line, rule, msg })

/** 剥掉围栏代码块 —— 里面的路径多是示意，不是断言 */
function stripFences(text) {
  let inFence = false
  return text.split('\n').map((l) => {
    if (/^\s*```/.test(l)) { inFence = !inFence; return '' }
    return inFence ? '' : l
  })
}

const PATHISH = /^[\w@][\w./@-]*\.(tsx?|jsx?|mjs|py|json|css|sql|ya?ml|toml|md)$|^[\w@][\w./@-]*\/$/

/** `ui/components/table.tsx` 要能对上 `packages/ui/src/components/table.tsx` —— 
 *  文档里的路径普遍省略 packages/ 和 src/，所以按「路径段有序子序列」匹配。 */
function segMatch(tok, cand) {
  const want = tok.replace(/\/$/, '').split('/')
  const have = cand.replace(/\/$/, '').split('/')
  let i = 0
  for (const h of have) if (h === want[i]) i += 1
  return i === want.length
}

function resolvePathish(tok) {
  const t = tok.replace(/^\.\//, '')
  if (fileSet.has(t) || dirSet.has(t.endsWith('/') ? t : t + '/')) return true
  const pool = t.endsWith('/') ? dirSet : allFiles
  for (const c of pool) if (segMatch(t, c)) return true
  // ⚠️ **兜一层真实文件系统。** 上面那几个集合来自本文件顶部那个扫描，
  // 而它会跳过以 `.` 开头的条目 —— 于是「目录里只有点文件」的路径永远进不了
  // `dirSet`，被判成「仓库里找不到」。
  //
  // 实测撞到：`apps/api/deploy/backend/docker-compose/` 里只有
  // `.env.server` 和 `.env.server.example`，`deploy/README.md` 指它时被报死引用，
  // 而那个目录是真的在。误报比漏报更伤 —— 它会让人去「修」一份本来正确的文档。
  return existsSync(resolve(ROOT, t))
}

for (const file of ctxFiles) {
  const raw = readFileSync(join(ROOT, file), 'utf8')
  const lines = stripFences(raw)
  // ⚠️ 末尾换行后面那个空串**不是一行**。原来直接 `split('\n').length`，
  // 每个文件都多算 1 行 —— 而这个 +1 真的让人白削过文档：一份 400 行、
  // 预算 400 的文件会被报成「401 行超预算」，然后有人去删掉一句真内容。
  const total = raw.replace(/\n$/, '').split('\n').length
  const budget = BUDGET[file] ?? BUDGET.default

  // 1) 行数预算
  if (total > budget) {
    add('warn', file, 1, 'budget',
      `${total} 行，超过预算 ${budget} —— 该按模块拆出去了`)
  }

  // 2) AGENTS.md 必须落在真有源码的目录上
  if (file.endsWith('AGENTS.md')) {
    const dir = file.slice(0, -'AGENTS.md'.length)
    const has = allFiles.some((f) => f.startsWith(dir) && SRC_EXT.test(f))
    if (!has) add('error', file, 1, 'empty-scope', `${dir || './'} 下没有任何源码文件`)

    // 8) 分册序言：H1 之后必须有一段声明「我是谁的分册」
    //
    // 为什么值得做成规则：这份声明**不是格式洁癖**，它带着两条给下一个人
    // （和下一个 agent）的指令 —— 「惰性加载，可以写细」和「新增结论追加到
    //  离代码最近的那一份」。缺了它，写文档的人不知道该往哪儿写，
    // 于是全堆进根 CLAUDE.md，而根文件超预算就开始掉注意力。
    //
    // 实测：28 份分册里 3 份完全没有这段，另有 9 份措辞各不相同
    // （模块分册长/短两版 + 子分册版混用），而「谁是谁的子册」压根对不上目录层级。
    //
    // 判据是**可推导**的，所以能查：目录的某个祖先也有 AGENTS.md → 子分册
    //（链到最近的那个祖先）；否则 → 模块分册（链到根 CLAUDE.md）。
    const here = dir.replace(/\/$/, '')
    let anc = here
    let parent = null
    while (anc.includes('/') || anc) {
      anc = anc.includes('/') ? anc.slice(0, anc.lastIndexOf('/')) : ''
      if (!anc) break
      if (fileSet.has(`${anc}/AGENTS.md`)) { parent = `${anc}/AGENTS.md`; break }
    }
    // 9) H1 必须点名自己的目录。
    //
    // 同时挂着七八份分册时，`# 生产部署` / `# 富文本编辑器` 这种标题不告诉你
    // 「这是哪个目录的规矩」—— 而分册之间的区别恰恰是目录。
    // 判据取**目录名**（不是完整路径），所以 `# pages/menu —— 死链判定` 和
    // `# packages/platform/src/pages/menu —— …` 都算过。
    const base = here.includes('/') ? here.slice(here.lastIndexOf('/') + 1) : here
    if (base && !(lines[0] ?? '').includes(base)) {
      add('error', file, 1, 'anonymous-title',
        `H1 里没出现目录名 ${base} —— 写成「# <短路径> —— <一句话>」`)
    }

    const head = lines.slice(0, 15).join('\n')
    const decl = head.match(/这份文件是[^\n]*?\]\(([^)]+)\)/)
    if (!decl) {
      add('error', file, 1, 'missing-preamble',
        `H1 之后缺「这份文件是…分册」的声明 —— 少了它，下一个人不知道结论该往哪份文件写`)
    } else {
      const want = relative(join(ROOT, here), join(ROOT, parent ?? 'CLAUDE.md')).replaceAll('\\', '/')
      const kind = parent ? '子分册' : '模块分册'
      if (!head.includes(`**${kind}**`)) {
        add('error', file, 1, 'wrong-preamble-kind',
          `${parent ? `它在 ${parent.replace(/\/AGENTS\.md$/, '')} 底下，` : '它不在任何分册底下，'}应该声明成**${kind}**`)
      }
      if (decl[1] !== want) {
        add('error', file, 1, 'wrong-preamble-link',
          `序言链到了 ${decl[1]}，应该是 ${want}（${parent ?? '根 CLAUDE.md'}）`)
      }
    }
  }

  lines.forEach((line, i) => {
    const ln = i + 1

    // 3) 死引用：反引号里的路径
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim()
      if (!PATHISH.test(tok)) continue
      if (tok.startsWith('@')) continue                 // npm 包名
      if (ALLOW.has(tok)) continue
      if (!resolvePathish(tok)) {
        add('error', file, ln, 'dead-path', `\`${tok}\` 在仓库里找不到`)
      }
    }

    // 4) markdown 本地链接
    for (const m of line.matchAll(/\]\((\.\/[^)]+|\.\.\/[^)]+)\)/g)) {
      const target = m[1].split('#')[0]
      if (!existsSync(resolve(ROOT, dirname(file), target))) {
        add('error', file, ln, 'dead-link', `链接 ${target} 指向不存在的文件`)
      }
    }

    // 5) pnpm 脚本（只认反引号/代码里的，正文里「pnpm workspace 成员」是散文不是断言）
    const code = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join(' ')
    for (const m of code.matchAll(/pnpm (?:--filter [\w@/-]+ )?([\w:]+)/g)) {
      const s = m[1]
      if (['install', 'add', 'remove', 'run', 'exec', 'dlx', 'why', 'ls'].includes(s)) continue
      if (!scripts.has(s)) {
        add('error', file, ln, 'dead-script', `pnpm ${s} —— 没有任何 package.json 声明这个脚本`)
      }
    }

    // 6) 章节交叉引用：「见「XXX」」必须能在**同一份**文件里找到那一节。
    //    拆分册最容易留下的债就是这个 —— 原来同文件的引用，拆完变成了指向别处，
    //    读的人翻遍手上这一份也找不到，而路径校验一个字都看不出来。
    for (const m of line.matchAll(/见「([^」]{2,60})」/g)) {
      const ref = m[1]
      const owners = ownersOf(ref)
      if (owners.length === 0) {
        add('error', file, ln, 'dead-anchor', `「${ref}」—— 全仓没有这个章节`)
      } else if (!owners.includes(file)) {
        add('error', file, ln, 'cross-file-anchor',
          `「${ref}」在 ${owners[0]}，不在本册 —— 改成 markdown 相对链接`)
      }
    }

    // 7) data-testid
    for (const m of line.matchAll(/data-testid[=:]"?([\w-]+)"?/g)) {
      const id = m[1]
      if (!srcBlob.includes(id)) {
        add('error', file, ln, 'dead-testid', `data-testid "${id}" 在源码里不存在`)
      }
    }
  })
}

// ── 输出 ──────────────────────────────────────────────────────────────
const errors = problems.filter((p) => p.level === 'error')
const warns = problems.filter((p) => p.level === 'warn')

const byFile = new Map()
for (const p of problems) {
  if (QUIET && p.level !== 'error') continue
  if (!byFile.has(p.file)) byFile.set(p.file, [])
  byFile.get(p.file).push(p)
}

for (const [file, ps] of byFile) {
  console.log(`\n${file}`)
  for (const p of ps.sort((a, b) => a.line - b.line)) {
    const tag = p.level === 'error' ? '✗' : '!'
    console.log(`  ${tag} ${String(p.line).padStart(4)}  [${p.rule}] ${p.msg}`)
  }
}

console.log(`\n上下文文件 ${ctxFiles.length} 份 · 错误 ${errors.length} · 警告 ${warns.length}`)
if (errors.length === 0 && warns.length === 0) console.log('[ok] 没有漂移')
process.exit(errors.length ? 1 : 0)
