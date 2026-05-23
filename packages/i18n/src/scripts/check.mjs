/**
 * 语言包校验。`pnpm --filter @admin/i18n check`（加 `--fix` 自动修可修的）
 *
 * 规则参照 Rocket.Chat 的 `packages/i18n/src/scripts/check.mts`，
 * 挑了对我们真正有用的几条（他们那 13 条里有一半是历史迁移用的）：
 *
 *   sort-keys            基准语言按 key 排序，其他语言跟随 —— diff 才可读     [可 --fix]
 *   missing-keys         代码里 t('…') 用到但语言包里没有                      硬失败
 *   extra-keys           语言包里有、代码里已无（文案改过/删过）               [可 --fix]
 *   missing-placeholder  译文丢了基准语言有的 {{var}} —— i18next 会渲染成空    硬失败
 *   extra-placeholder    译文凭空多出 {{var}} —— 会渲染成字面量 {{var}}        硬失败
 *   missing-translation  目标语言缺条目                                        警告
 *   untranslated         目标语言与基准语言逐字相同（大概率漏翻）              警告
 *
 * 「中文原文即 key」的代价就是改中文文案会让译文失效，这个脚本是唯一的兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from './strip-comments.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const localesDir = path.resolve(here, '../locales')
const repoRoot = path.resolve(here, '../../../..')
const BASE = 'zh-CN'
const fix = process.argv.includes('--fix')

/** 扫代码里的 key。只认字符串字面量 —— 和抽取器同口径（GitLab 同样的硬规则） */
// 也扫自己：formatDuration 里的 `{{n}} 小时` 之类同样是语言包 key
const SRC_ROOTS = ['apps/web/src', 'packages/i18n/src', 'packages/platform/src', 'packages/ui/src']
/**
 * 不纳管的目录。前四个是组件沙箱/试验页（只有开发工具菜单能进，不对业务用户露出）；
 * `query-bar` / `data-grid` 目前只被沙箱页引用，还在迭代中，等它们进业务页再一起纳管。
 */
const SKIP_DIRS = new Set([
  'node_modules', 'locales', 'dev-sandbox', 'playground-table', 'playground-query', 'sandbox',
  'data-grid',
])
const LITERAL = /\bt\(\s*(['"])((?:(?!\1)[\s\S])*?)\1/g
/** `<Trans i18nKey="…">` —— 整句带内联标签的那种，同样是静态 key */
const TRANS_KEY = /\bi18nKey=(?:\{)?(['"])((?:(?!\1)[\s\S])*?)\1/g
/**
 * 代码里所有含中文的字符串字面量 —— 用来兜住「t(变量) / 常量表」那一类动态 key：
 * 只出现在这里、没出现在 t('…') 里的，算「动态候选」而不算孤儿，
 * 否则 --fix 会把 registry.ts 的 label/hint、STATUS_META 之类整片删掉。
 */
const ANY_CN_LITERAL = /(['"`])((?:(?!\1)[^\n])*[一-鿿](?:(?!\1)[^\n])*)\1/g
const CN = /[一-鿿]/

// 先剥掉注释再扫。中文注释里的成对引号（`用 'a' 而不是 'b'`）会被
// ANY_CN_LITERAL 当成字符串字面量，动态 key 提醒里就会塞进几百条散碎片段。
// 实现在 strip-comments.mjs —— 它必须是**字符串感知**的，原因见那个文件的注释
// （`accept="image/*"` 曾经把它后面整段代码的 key 全吃掉）。

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out)
    } else if (/\.tsx?$/.test(e.name)) out.push(path.join(dir, e.name))
  }
  return out
}

const literalKeys = new Map() // key -> 首个出现的文件
const dynamicKeys = new Map() // t(变量) 的候选，只提醒
for (const r of SRC_ROOTS) {
  for (const f of walk(path.join(repoRoot, r))) {
    const src = stripComments(fs.readFileSync(f, 'utf8'))
    const rel = path.relative(repoRoot, f)
    for (const re of [LITERAL, TRANS_KEY]) {
      for (const m of src.matchAll(re)) {
        if (CN.test(m[2]) && !literalKeys.has(m[2])) literalKeys.set(m[2], rel)
      }
    }
    for (const m of src.matchAll(ANY_CN_LITERAL)) {
      if (!literalKeys.has(m[2]) && !dynamicKeys.has(m[2])) dynamicKeys.set(m[2], rel)
    }
  }
}

/**
 * 后端数据里的中文（`sys_config.name`、操作日志 `title`、字典/部门名…）。
 *
 * 这些 key 在代码里**根本不会出现**——渲染处写的是 `t(item.name)`，
 * 值来自数据库。没有白名单的话 extra-keys 会把它们全判成孤儿，
 * `--fix` 一跑就整片删掉，英文界面上这些字段瞬间回中文。
 * 后端加了新配置项就往这里补一条（同时补两个语言包）。
 */
const serverKeys = new Set(
  JSON.parse(fs.readFileSync(path.resolve(here, '../server-data-keys.json'), 'utf8'))
)

const files = fs.readdirSync(localesDir).filter((f) => f.endsWith('.json'))
const load = (f) => JSON.parse(fs.readFileSync(path.join(localesDir, f), 'utf8'))
const save = (f, obj) => fs.writeFileSync(path.join(localesDir, f), JSON.stringify(obj, null, 2) + '\n')

const targets = files.filter((f) => f !== `${BASE}.json`)

let errors = 0
let warnings = 0
const err = (rule, msg) => {
  console.error(`[x] ${rule}: ${msg}`)
  errors += 1
}
const warn = (rule, msg) => {
  console.warn(`[!] ${rule}: ${msg}`)
  warnings += 1
}

const PH = /\{\{\s*([\w.]+)\s*\}\}/g
const placeholders = (s) => new Set([...String(s).matchAll(PH)].map((m) => m[1]))

// -- sort-keys ---------------------------------------------------------------
for (const f of files) {
  const obj = load(f)
  const keys = Object.keys(obj)
  const sorted = [...keys].sort()
  if (keys.join(' ') === sorted.join(' ')) continue
  if (fix) {
    save(f, Object.fromEntries(sorted.map((k) => [k, obj[k]])))
    console.log(`[ok] sort-keys: ${f} 已排序`)
  } else {
    err('sort-keys', `${f} 的 key 没有按字典序排列（--fix 可自动修）`)
  }
}

// -- missing-keys / extra-keys ----------------------------------------------
{
  const base = load(`${BASE}.json`)
  const missing = [...literalKeys.keys()].filter((k) => !(k in base))
  for (const k of missing.slice(0, 30)) err('missing-keys', `${JSON.stringify(k)} <- ${literalKeys.get(k)}`)
  if (missing.length > 30) err('missing-keys', `…还有 ${missing.length - 30} 条`)

  const known = new Set([...literalKeys.keys(), ...dynamicKeys.keys(), ...serverKeys])
  const extra = Object.keys(base).filter((k) => !known.has(k) && !k.startsWith('menu:'))
  // 白名单里已经不需要的（后端那条配置/日志类型删了）也要提醒，否则名单只会越长
  const staleServerKeys = [...serverKeys].filter((k) => !(k in base))
  if (staleServerKeys.length)
    warn('stale-server-keys', `server-data-keys.json 里 ${staleServerKeys.length} 条已不在语言包：${staleServerKeys.slice(0, 5).map((k) => JSON.stringify(k)).join(', ')}`)
  if (extra.length) {
    if (fix) {
      for (const f of files) {
        const obj = load(f)
        for (const k of extra) delete obj[k]
        save(f, obj)
      }
      console.log(`[ok] extra-keys: 清掉 ${extra.length} 条孤儿`)
    } else {
      warn(
        'extra-keys',
        `${extra.length} 条孤儿（代码里已无此 key，--fix 可清）：${extra.slice(0, 6).map((k) => JSON.stringify(k)).join(', ')}`
      )
    }
  }
}

// -- 占位符一致性 + 漏翻 ------------------------------------------------------
{
  const base = load(`${BASE}.json`)
  for (const f of targets) {
    const obj = load(f)
    for (const [k, baseVal] of Object.entries(base)) {
      const val = obj[k]
      if (val === undefined || val === '') {
        warn('missing-translation', `${f}: ${JSON.stringify(k)}`)
        continue
      }
      const bp = placeholders(baseVal)
      const tp = placeholders(val)
      for (const p of bp) if (!tp.has(p)) err('missing-placeholder', `${f}: ${JSON.stringify(k)} 少了 {{${p}}}`)
      for (const p of tp) if (!bp.has(p)) err('extra-placeholder', `${f}: ${JSON.stringify(k)} 多了 {{${p}}}`)
      if (val === baseVal && CN.test(val)) warn('untranslated', `${f}: ${JSON.stringify(k)} 与基准语言逐字相同`)
    }
  }
}

// -- shadowed-t：局部变量/回调参数叫 t，把翻译函数遮蔽掉 -----------------------
{
  /*
   * 已经踩过四次，每次都很贵：
   *   profile 的 `TABS.map((t) => …{t.label})`
   *   dict/index 的 `shownTypes.map((t) => …)`
   *   registry.ts 的 `const t = n('USER_LOCK_THRESHOLD')`
   *   role/index 的 `TABS.map((t) => …{t.label})`  ← 三个 tab 从来没翻，用户截图指出来的
   *
   * 危险之处在于它**不一定报错**：`{t.label}` 里 t 是对象时 tsc 会拦
   * （"has no call signatures"），但 `const t = 5` 之后 `t('x')` 也只是运行时才炸，
   * 而 sectionSummary 那种「返回原文」的写法连炸都不炸 —— 静默不翻。
   * 所以只能靠静态规则挡在前面。
   */
  const DECL = [
    // 箭头函数/普通函数的参数：(t) => / (t, i) => / function (t)
    /\(\s*t\s*(?:,[^)]*)?\)\s*=>/g,
    /function\s*\*?\s*[\w$]*\s*\(\s*t\s*(?:,|\))/g,
    // const/let/var t = …（`const { t } = useTranslation()` 是解构，不会命中）
    /\b(?:const|let|var)\s+t\s*[=:]/g,
    // for (const t of …)
    /for\s*\(\s*(?:const|let|var)\s+t\s+(?:of|in)\b/g,
  ]
  for (const r of SRC_ROOTS) {
    for (const f of walk(path.join(repoRoot, r))) {
      const src = stripComments(fs.readFileSync(f, 'utf8'))
      // 只在「这个文件真的在用翻译函数」时才管 —— 别去管纯工具文件里的 t
      if (!/from '(?:react-i18next|@admin\/i18n)'/.test(src)) continue
      const rel = path.relative(repoRoot, f)
      for (const re of DECL) {
        for (const m of src.matchAll(re)) {
          const line = src.slice(0, m.index).split('\n').length
          err('shadowed-t', `${rel}:${line} 声明了叫 t 的变量/参数，会遮蔽翻译函数 —— 改个名（${m[0].trim()}）`)
        }
      }
    }
  }
}

// -- 动态 key 提醒（不算失败：对象值里的中文不一定真走 t()）-------------------
{
  const base = load(`${BASE}.json`)
  const dynMissing = [...dynamicKeys.keys()].filter((k) => !(k in base))
  if (dynMissing.length) {
    console.log(`\n[i] 动态 key 候选未纳管 ${dynMissing.length} 条（t(变量) 形态，不一定真走 t()，仅提醒）:`)
    const limit = process.argv.includes('--all') ? dynMissing.length : 10
    for (const k of dynMissing.slice(0, limit)) console.log(`    ${JSON.stringify(k)} <- ${dynamicKeys.get(k)}`)
    if (dynMissing.length > limit) console.log(`    …还有 ${dynMissing.length - limit} 条`)
  }
}

const base = load(`${BASE}.json`)
console.log(`\n基准语言 ${BASE}: ${Object.keys(base).length} 条 | 目标语言: ${targets.join(', ') || '(无)'}`)
console.log(`代码里的字面量 key: ${literalKeys.size} 条`)
console.log(errors ? `\n[x] ${errors} 个错误、${warnings} 个警告` : `\n[ok] 通过（${warnings} 个警告）`)
process.exit(errors ? 1 : 0)
