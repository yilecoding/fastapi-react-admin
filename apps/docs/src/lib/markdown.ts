/**
 * 把文档页还原成一份给 AI / 命令行读的纯 Markdown：每页的 `.md` 原文、`llms.txt`、`llms-full.txt` 都从这里出。
 *
 * 内容源是 `.md` / `.mdx` 的正文（不是渲染后的 HTML）：标题层级、表格、代码块原样保留，
 * 这正是模型读起来最省 token 的形态。`.mdx` 里给人看的部分（import、`<ProductShot />` 这类组件）去掉。
 */
import type { CollectionEntry } from 'astro:content'
import { DOC_SECTIONS } from '../navigation.mjs'

type Doc = CollectionEntry<'docs'>

const SITE = (import.meta.env.SITE ?? '').replace(/\/$/, '')
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
/** 带域名的站点根，比如 https://yilecoding.github.io/fastapi-react-admin */
export const ROOT = `${SITE}${BASE}`

export const pageUrl = (id: string) => `${ROOT}/${id}/`
export const markdownUrl = (id: string) => `${ROOT}/${id}.md`
/** 不带域名的 `.md` 路径：页面上的按钮用它（本地预览时也指向本地） */
export const markdownPath = (id: string) => `${BASE}/${id}.md`

/** 首页是一堆组件，没有可读的正文；404 不是文档 */
export const hasMarkdown = (doc: Doc) => !doc.data.hero && doc.id !== '404' && doc.id !== 'en/404'

export function toMarkdown(doc: Doc): string {
  let fenced = false
  const body = (doc.body ?? '')
    .split(/\r?\n/)
    .flatMap((line) => {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return [line] }
      if (fenced) return [line] // 代码块里的东西一个字都不动
      // mdx 的 import 行，和独占一行的组件标签（<ProductShot … />、<Steps>、</Steps>）
      if (/^import\s.+from\s+['"].+['"];?\s*$/.test(line) || /^\s*<\/?[A-Z][\w.]*(\s[^>]*)?\/?>\s*$/.test(line)) return []
      // 正文里 `/xxx/` 形式的站内链接补成带域名的完整地址 —— 这份文本会被贴到别处去读
      return [line.replace(/\]\(\/(?!\/)/g, `](${ROOT}/`)]
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const head = [`# ${doc.data.title}`, doc.data.description && `> ${doc.data.description}`, `Source: ${pageUrl(doc.id)}`]
  return `${head.filter(Boolean).join('\n\n')}\n\n${body}\n`
}

/** 按 `DOC_SECTIONS` 的分类和顺序排好的页面；`locale` 是 `''`（中文）或 `'en'` */
export function sectionsOf(docs: Doc[], locale: string) {
  const prefix = locale ? `${locale}/` : ''
  const byId = new Map(docs.map((doc) => [doc.id, doc]))
  return DOC_SECTIONS.map((section) => ({
    label: locale === 'en' ? section.en : section.label,
    docs: section.pages.map((page) => byId.get(prefix + page)).filter((doc): doc is Doc => !!doc),
  }))
}

export const text = (body: string) => new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
