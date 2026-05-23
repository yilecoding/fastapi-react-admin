/**
 * JSX 文本节点扫描 —— `check.mjs` 的盲区补丁。`pnpm i18n:jsx`
 *
 * `check.mjs` 的 `t('…')` 正则只看**字符串字面量**，而
 *
 *     <IconPencil className="size-4" />编辑
 *
 * 里的「编辑」是 JSX **文本节点**：校验器一个字都看不见，界面上却是明明白白的中文。
 * 第一次跑出来 114 处，全是真漏的（每个 ⋯ 菜单里的「编辑 / 删除」都在里面）。
 *
 * 原理：剥注释 → 把所有字符串 / 模板字面量掏空 → 剩下的中文只可能是 JSX 文本。
 * 干净状态下应当输出 0 处。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './strip-comments.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../../../..')

const ROOTS = ['apps/web/src', 'packages/platform/src', 'packages/ui/src']
/** 与 check.mjs 的 SKIP_DIRS 保持一致 —— 沙箱与在建组件不纳管 */
const SKIP = new Set([
  'node_modules', 'locales', 'dev-sandbox', 'playground-table', 'playground-query', 'sandbox',
  'data-grid',
])
const CN = /[一-鿿]/

const files = []
function walk(dir) {
  if (!fs.existsSync(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(path.join(dir, e.name))
    } else if (e.name.endsWith('.tsx')) files.push(path.join(dir, e.name))
  }
}
ROOTS.forEach((r) => walk(path.join(repoRoot, r)))

let hits = 0
for (const f of files) {
  const raw = fs.readFileSync(f, 'utf8')
  // 块注释整文件剥（换行与列数都留着，行号才对得上），行注释与字面量逐行剥。
  // 用字符串感知的 stripper —— 裸正则会把 `accept="image/*"` 当成注释开头
  const stripped = stripComments(raw, { keepLines: true, blankStrings: true })
  const rawLines = raw.split('\n')
  stripped.split('\n').forEach((line, i) => {
    const bare = line
      .replace(/(^|[^:'"`\\])\/\/.*$/, '$1')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    if (!CN.test(bare)) return
    hits += 1
    console.log(`${path.relative(repoRoot, f)}:${i + 1}: ${rawLines[i].trim().slice(0, 130)}`)
  })
}

console.log(hits ? `\n[x] JSX 文本节点残留 ${hits} 处（应为 0，用 {t('…')} 或 <Trans> 包起来）` : '\n[ok] 没有裸露的 JSX 中文文本')
process.exit(hits ? 1 : 0)
