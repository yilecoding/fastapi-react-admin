#!/usr/bin/env node
/**
 * 构建后核对站内链接：`dist` 里每一页的每个站内 href（带 base 的绝对路径、相对路径、`#锚点`）
 * 都要落在一个真实存在的页面和 id 上。接在 `build` 后面，所以 PR 的 CI 就会红。
 *
 * 为什么要它：站点挂在子路径下，链接写错的方式很多而且都不报错 —— 正文漏了 base、
 * MDX 组件里写了 `/` 开头的链接（remark 插件管不到）、页面改名后旧链接还在、中文小标题的
 * 锚点和英文对不上。Astro 构建对这些一律放行，上线之后才是一个 404。
 *
 * 不查外链（GitHub、演示站）：那些不归本站管，查了会被网络抖动带红。
 * `/e2e/` 跳过：E2E 报告是 CI 的 pages job 在构建之后才拼进来的。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
const SITE = 'https://yilecoding.github.io'
const BASE = '/fastapi-react-admin'

const pages = []
;(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== '_astro' && e.name !== 'pagefind') walk(p)
    } else if (e.name.endsWith('.html') && e.name !== '404.html') {
      // 404 页的 canonical / hreflang 指向不存在的 /404/，它本来就不是一个可导航的页面
      pages.push(p)
    }
  }
})(DIST)

const idCache = new Map()
function idsOf(file) {
  if (!idCache.has(file)) {
    const html = readFileSync(file, 'utf8')
    idCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))))
  }
  return idCache.get(file)
}

const broken = []
let ok = 0
for (const file of pages) {
  const rel = relative(DIST, file).replaceAll('\\', '/')
  const pageUrl = `${BASE}/${rel.replace(/index\.html$/, '')}`
  for (const [, raw] of readFileSync(file, 'utf8').matchAll(/href="([^"]+)"/g)) {
    let href = raw.replaceAll('&amp;', '&')
    if (href.startsWith(SITE + BASE)) href = href.slice(SITE.length)
    else if (/^[a-z]+:/i.test(href) || href.startsWith('//')) continue
    if (href.startsWith('#')) href = pageUrl + href

    const abs = href.startsWith('/') ? href : posix.join(posix.dirname(`${pageUrl}x`), href)
    const [path, hash] = abs.split('#')
    if (path !== BASE && !path.startsWith(`${BASE}/`)) {
      broken.push(`${rel} → ${raw}（没带 ${BASE}，会落到域名根上）`)
      continue
    }
    if (path.startsWith(`${BASE}/e2e/`)) continue

    let target = join(DIST, decodeURIComponent(path.slice(BASE.length)))
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html')
    if (!existsSync(target)) {
      broken.push(`${rel} → ${raw}（页面不存在）`)
      continue
    }
    if (hash && hash !== '_top' && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(hash))) {
      broken.push(`${rel} → ${raw}（锚点不存在）`)
      continue
    }
    ok += 1
  }
}

for (const b of new Set(broken)) console.log(`  ✗ ${b}`)
console.log(`站内链接：${pages.length} 页 · ${ok} 条通过 · ${new Set(broken).size} 条断链`)
process.exit(broken.length ? 1 : 0)
