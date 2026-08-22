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
const SRC_EXT = /\.(tsx?|jsx?|mjs|py|css|json|sql|toml)$/
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
  .filter((f) => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(f))
  // 每个模块目录下是 AGENTS.md（真身）+ CLAUDE.md（符号链接），
  // 不去重的话同一条问题会报两遍
  .filter((f) => !lstatSync(join(ROOT, f)).isSymbolicLink())

/**
 * 豁免表：文档提到这些东西**正是因为它们不存在**（已删除 / 刻意不用 /
 * 运行时才生成）。登记时必须写理由 —— 没理由的豁免下次就没人敢删了。
 */
const ALLOW = new Map(Object.entries({
  'versions/': 'alembic 迁移目录，文档说的就是「它是空的」',
  'backend/upload/': '运行时创建的上传目录，不进 git',
  'backend/upload-public/': '同上，公开子树',
  'storageState.json': 'Playwright 的概念，文档说的就是「这条路走不通」',
  'settings-layout.tsx': '已被 settings-shell.tsx 取代，文档在讲换掉它的理由',
}))

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
  return false
}

for (const file of ctxFiles) {
  const raw = readFileSync(join(ROOT, file), 'utf8')
  const lines = stripFences(raw)
  const total = raw.split('\n').length
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

    // 6) data-testid
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
