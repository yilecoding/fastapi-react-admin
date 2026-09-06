#!/usr/bin/env node
/**
 * 生成 `packages/ui/registry.json` —— shadcn CLI 认的组件清单。
 *
 * ## 为什么要有它
 *
 * `packages/ui` 的定位是**被下游整包拿走自己改**（见 `packages/ui/PORTING.md`）。
 * 「整包拷走」已经能用，但粒度太粗：下家往往只要一个 `DataTable`，
 * 却得先拷 45 个组件再删掉 44 个。registry 让他们
 * `npx shadcn add <url>/data-table` 逐个取用，依赖自动带上。
 *
 * ## 为什么是**生成**的，不是手写的
 *
 * 手写的 registry 会漂 —— 加一个组件、改一处 import，清单不会自己跟上，
 * 而失败方式是**静默**的：`shadcn add` 照常成功，只是少拷了一个文件，
 * 下家那边编译时才炸，报的是「找不到 ./checkbox」，跟 registry 八竿子打不着。
 *
 * 所以依赖关系从**源码的 import 语句**里算出来，不靠人维护。
 * `--check` 模式给闸门用（`pnpm arch:check` 会调 `buildRegistry()` 比对）。
 *
 * ```bash
 * pnpm ui:registry           # 重新生成
 * pnpm ui:registry --check   # 只比对，不写（CI / 闸门用）
 * ```
 */

import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const UI = path.join(ROOT, 'packages/ui')
const COMPONENTS = path.join(UI, 'src/components')
const REGISTRY_PATH = path.join(UI, 'registry.json')

/** 除组件外还要能单独取的东西：`cn()`、翻译入口、hook */
const EXTRA = [
  { name: 'utils', type: 'registry:lib', files: ['src/lib/utils.ts'] },
  { name: 'i18n', type: 'registry:lib', files: ['src/lib/i18n.ts'] },
  { name: 'use-mobile', type: 'registry:hook', files: ['src/hooks/use-mobile.ts'] },
]

/**
 * 剥注释 —— 否则「不要 import xxx」这种说明文字会被当成真的 import。
 * 和 `arch-check.mjs` 同一个理由，这里只需要一个够用的版本
 * （registry 生成失败会被 `--check` 抓到，不像那边是静默漏检）。
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })

/** 一个 registry 条目要收的文件：单文件组件就一个，目录组件是整个目录 */
function filesOf(name) {
  const dir = path.join(COMPONENTS, name)
  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    return walk(dir)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => path.relative(UI, f).split(path.sep).join('/'))
      .sort()
  }
  const tsx = path.join(COMPONENTS, `${name}.tsx`)
  const ts = path.join(COMPONENTS, `${name}.ts`)
  const own = fs.existsSync(tsx) ? tsx : ts
  const files = [own]
  // 纯逻辑姊妹文件跟着主组件走（`tree.tsx` ↔ `tree-state.ts`）——
  // 单独成条目没意义，下家要的是「树」这个东西
  const sibling = path.join(COMPONENTS, `${name}-state.ts`)
  if (fs.existsSync(sibling)) files.push(sibling)
  return files.map((f) => path.relative(UI, f).split(path.sep).join('/')).sort()
}

export function buildRegistry() {
  const pkg = JSON.parse(fs.readFileSync(path.join(UI, 'package.json'), 'utf8'))
  const npmDeps = new Set(Object.keys(pkg.dependencies ?? {}))

  const names = fs
    .readdirSync(COMPONENTS, { withFileTypes: true })
    .flatMap((e) => {
      if (e.isDirectory()) return [e.name]
      if (!e.name.endsWith('.tsx')) return []
      return [e.name.replace(/\.tsx$/, '')]
    })
    .sort()

  // `xxx-state.ts` 不单独成条目，它跟着 `xxx.tsx` 走
  const owned = new Set(
    names.flatMap((n) => filesOf(n)).map((f) => f.replace(/^src\/components\//, ''))
  )
  void owned

  const items = []

  for (const entry of [...names.map((n) => ({ name: n, type: 'registry:ui' })), ...EXTRA]) {
    const files = entry.files ?? filesOf(entry.name)
    const deps = new Set()
    const registryDeps = new Set()

    for (const rel of files) {
      const src = stripComments(fs.readFileSync(path.join(UI, rel), 'utf8'))
      for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1]

        // 本包内部 —— 换算成 registry 条目名
        if (spec.startsWith('@admin/ui/')) {
          const rest = spec.slice('@admin/ui/'.length)
          if (rest.startsWith('components/')) registryDeps.add(rest.slice('components/'.length))
          else if (rest.startsWith('lib/')) registryDeps.add(rest.slice('lib/'.length))
          else if (rest.startsWith('hooks/')) registryDeps.add(rest.slice('hooks/'.length))
          continue
        }
        if (spec.startsWith('.')) {
          // 相对路径：只有指向本条目**之外**的才算依赖
          const abs = path.resolve(path.dirname(path.join(UI, rel)), spec)
          const relToUi = path.relative(UI, abs).split(path.sep).join('/')
          if (files.some((f) => f.replace(/\.(ts|tsx)$/, '') === relToUi)) continue
          if (relToUi.startsWith('src/lib/')) registryDeps.add(path.basename(relToUi))
          else if (relToUi.startsWith('src/hooks/')) registryDeps.add(path.basename(relToUi))
          else if (relToUi.startsWith('src/components/')) {
            registryDeps.add(relToUi.slice('src/components/'.length).split('/')[0])
          }
          continue
        }
        if (spec.startsWith('react/') || spec === 'react' || spec === 'react-dom') continue

        // 第三方：取包名（含 scope），且必须真的在 dependencies 里
        const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (npmDeps.has(pkgName)) deps.add(pkgName)
      }
    }
    registryDeps.delete(entry.name)

    items.push({
      name: entry.name,
      type: entry.type,
      ...(deps.size ? { dependencies: [...deps].sort() } : {}),
      ...(registryDeps.size ? { registryDependencies: [...registryDeps].sort() } : {}),
      files: files.map((f) => ({
        path: f,
        type: entry.type === 'registry:ui' ? 'registry:ui' : entry.type,
      })),
    })
  }

  return {
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: 'fastapi-react-admin',
    homepage: 'https://github.com/yilecoding/fastapi-react-admin',
    items,
  }
}

// ── CLI ───────────────────────────────────────────────────────────────
if (import.meta.filename === process.argv[1]) {
  const registry = buildRegistry()
  const text = `${JSON.stringify(registry, null, 2)}\n`

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(REGISTRY_PATH) ? fs.readFileSync(REGISTRY_PATH, 'utf8') : ''
    if (current !== text) {
      console.error('[x] registry.json 和源码对不上了 —— 跑 `pnpm ui:registry` 重新生成')
      process.exit(1)
    }
    console.log(`[ok] registry.json 是新的（${registry.items.length} 个条目）`)
  } else {
    fs.writeFileSync(REGISTRY_PATH, text)
    console.log(`[ok] 写入 ${path.relative(ROOT, REGISTRY_PATH)}（${registry.items.length} 个条目）`)
  }
}
