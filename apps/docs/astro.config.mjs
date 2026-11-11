// @ts-check
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

import { DOC_SECTIONS } from './src/navigation.mjs'

// 🔴 站点挂在子路径下（GitHub Pages 是 yilecoding.github.io/fastapi-react-admin/），
// Astro 只给它自己生成的链接（侧边栏、上下篇、语言切换）补 base，**正文里手写的
// `/xxx/` 链接不补** —— 不补就是指向域名根上的 404。
// 下面的 remark 插件把正文里以 `/` 开头的站内链接统一补上 base，写文档时照常写
// `/getting-started/quick-start/` 就行。
// 同一份源码要发到两个地方（GitHub Pages 和自己的服务器），所以 SITE / BASE 走环境变量；
// `scripts/check-links.mjs` 读的是同一对变量。
const SITE = process.env.DOCS_SITE ?? 'https://yilecoding.github.io'
const BASE = process.env.DOCS_BASE ?? '/fastapi-react-admin'

const REPO = 'https://github.com/yilecoding/fastapi-react-admin'

/**
 * 中文是默认语言（先推国内）。浏览器语言不是中文的访客进中文页时，右下角给一条
 * 「Read in English」—— 只提示、不跳转：按 IP / 语言自动跳转会让爬虫永远只看到一种语言，
 * Google 明确不建议。关掉后记在 localStorage，不再出现。
 */
const EN_HINT = `(() => {
  const base = ${JSON.stringify(BASE)}
  const path = location.pathname
  if (!path.startsWith(base) || path.startsWith(base + '/en/') || path === base + '/en') return
  if ((navigator.languages || [navigator.language]).some((l) => /^zh/i.test(l))) return
  try { if (localStorage.getItem('docs:en-hint') === 'off') return } catch {}
  addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div')
    bar.className = 'en-hint'
    bar.innerHTML = '<span>This page is in Chinese.</span><a></a><button type="button" aria-label="Dismiss">×</button>'
    const a = bar.querySelector('a')
    a.href = base + '/en' + (path.slice(base.length) || '/') + location.hash
    a.textContent = 'Read in English →'
    bar.querySelector('button').onclick = () => { bar.remove(); try { localStorage.setItem('docs:en-hint', 'off') } catch {} }
    document.body.append(bar)
  })
})()`

/** 全站文章必须在分类中恰好出现一次；首页不参与内页导航。 */
function checkDocSections() {
  const listed = DOC_SECTIONS.flatMap((section) => section.pages)
  const problems = listed.filter((p, i) => listed.indexOf(p) !== i).map((p) => `「${p}」登记了不止一次`)
  for (const locale of ['', 'en/']) {
    const root = fileURLToPath(new URL(`./src/content/docs/${locale}`, import.meta.url))
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.mdx?$/.test(entry.name))
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/').replace(/\.mdx?$/, ''))
      .filter((path) => path !== 'index' && !path.startsWith('en/'))
    for (const path of files) if (!listed.includes(path)) problems.push(`${locale}${path} 没有登记进 DOC_SECTIONS，导航里看不到它`)
    for (const path of listed) if (!files.includes(path)) problems.push(`DOC_SECTIONS 里的「${path}」在 ${locale || '中文'}目录下没有文件`)
  }
  if (problems.length) throw new Error(`文档分类对不上：\n  ${problems.join('\n  ')}`)
}
checkDocSections()

/** 正文里 `/` 开头的站内链接补上 base（`//host` 这种协议相对地址不动，已经带 base 的不重复补） */
function remarkBaseLinks() {
  /** @param {any} node */
  const visit = (node) => {
    if ((node.type === 'link' || node.type === 'definition')
      && node.url.startsWith('/') && !node.url.startsWith('//') && !node.url.startsWith(`${BASE}/`)) {
      node.url = BASE + node.url
    }
    node.children?.forEach(visit)
  }
  return visit
}

export default defineConfig({
  site: SITE,
  base: BASE,
  markdown: { remarkPlugins: [remarkBaseLinks] },
  integrations: [
    starlight({
      title: 'fastapi-react-admin',
      description:
        '开源中后台底座，FastAPI + React 19 + shadcn/ui：行级数据权限、保状态多页签、审批流、不越权的 AI 助手，支持 PostgreSQL / SQL Server / MySQL。',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      // 主题和后台同一套：Inter / JetBrains Mono 自托管（不走 Google Fonts —— 国内打不开），品牌紫见 theme.css
      customCss: ['@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono', './src/styles/theme.css'],
      // 首页 hero 换成登录页那套品牌面板 + 立体榫卯（src/components/Hero.astro）
      // 顶栏的主题切换换成太阳 / 月亮两段式（src/components/ThemeSelect.astro）
      components: {
        Hero: './src/components/Hero.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        Header: './src/components/DocsHeader.astro',
        Sidebar: './src/components/DocsSidebar.astro',
      },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/apps/docs/` },
      // 每页显示「最后更新」—— 读 git 历史，所以 CI 里 checkout 要 fetch-depth: 0，
      // 浅克隆下每一页都会显示成「今天」
      lastUpdated: true,
      defaultLocale: 'root',
      // 中文在根路径、英文在 /en/：先推国内，右上角可切换
      locales: {
        root: { label: '简体中文', lang: 'zh-CN' },
        en: { label: 'English', lang: 'en' },
      },
      head: [
        // 链接分享到飞书 / Slack / X 时的卡片大图；Starlight 自己只出标题和描述
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE}${BASE}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE}${BASE}/og.png` } },
        { tag: 'script', content: EN_HINT },
      ],
      sidebar: DOC_SECTIONS.map((section) => ({
        label: section.label,
        translations: { en: section.en },
        items: section.pages,
      })),
    }),
  ],
})
