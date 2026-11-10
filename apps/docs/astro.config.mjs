// @ts-check
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

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
// E2E 报告只发在 GitHub Pages 上（CI 的 pages job 拼进去），别的部署也指向那里
const E2E_REPORT = 'https://yilecoding.github.io/fastapi-react-admin/e2e/'

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

/**
 * 「功能」分组下的子分组（#285）。按能力领域分，不按后台的菜单树分 —— 菜单树是部署方可以改的。
 *
 * 🔴 页面文件仍然**平放**在 `features/` 下，分组只在这里：已有的 `/features/xxx/` 已经被搜索引擎
 * 收录、首页和 README 也在链，挪进子目录就是一批 404。
 *
 * 手写分组的代价是「新加一页忘了登记」—— 那一页能访问、但侧边栏里没有，构建全绿。
 * 所以下面的 `checkFeatureGroups()` 在加载配置时核对：中英两边 `features/` 下的每一页都要在这里出现
 * 恰好一次，这里登记的每一页两边都要有文件。对不上就让 `astro build` / `astro dev` 直接失败。
 */
const FEATURE_GROUPS = [
  { label: '权限与安全', en: 'Access & security', pages: ['login-security', 'rbac', 'data-permissions', 'audit-logs'] },
  { label: '工作区', en: 'Workspace', pages: ['multi-tab'] },
  { label: '协同', en: 'Collaboration', pages: ['approval-workflow', 'notifications'] },
  { label: '文件与数据', en: 'Files & data', pages: ['import-export', 'file-storage', 'databases'] },
  { label: '集成与多端', en: 'Integrations & clients', pages: ['ai-assistant', 'open-api', 'clients'] },
]
const FEATURE_TOP = ['overview']

function checkFeatureGroups() {
  const listed = [...FEATURE_TOP, ...FEATURE_GROUPS.flatMap((g) => g.pages)]
  const problems = listed.filter((p, i) => listed.indexOf(p) !== i).map((p) => `「${p}」登记了不止一次`)
  for (const dir of ['features', 'en/features']) {
    const abs = fileURLToPath(new URL(`./src/content/docs/${dir}/`, import.meta.url))
    const files = readdirSync(abs).filter((f) => /\.mdx?$/.test(f)).map((f) => f.replace(/\.mdx?$/, ''))
    for (const f of files) if (!listed.includes(f)) problems.push(`${dir}/${f} 没有登记进 FEATURE_GROUPS，侧边栏里看不到它`)
    for (const p of listed) if (!files.includes(p)) problems.push(`FEATURE_GROUPS 里的「${p}」在 ${dir}/ 下没有文件`)
  }
  if (problems.length) throw new Error(`astro.config.mjs 的功能分组对不上：\n  ${problems.join('\n  ')}`)
}
checkFeatureGroups()

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
      components: { Hero: './src/components/Hero.astro', ThemeSelect: './src/components/ThemeSelect.astro' },
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
      sidebar: [
        {
          label: '开始',
          translations: { en: 'Getting started' },
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: '指南',
          translations: { en: 'Guides' },
          items: [{ autogenerate: { directory: 'guides' } }],
        },
        {
          label: '功能',
          translations: { en: 'Features' },
          items: [
            ...FEATURE_TOP.map((p) => `features/${p}`),
            ...FEATURE_GROUPS.map((g) => ({
              label: g.label,
              translations: { en: g.en },
              items: g.pages.map((p) => `features/${p}`),
            })),
          ],
        },
        {
          label: '参考',
          translations: { en: 'Reference' },
          items: [{ autogenerate: { directory: 'reference' } }],
        },
        {
          label: '链接',
          translations: { en: 'Links' },
          items: [
            { label: '在线演示', translations: { en: 'Live demo' }, link: 'https://fra.wubunan.com/sign-in', attrs: { target: '_blank' } },
            { label: 'E2E 报告', translations: { en: 'E2E report' }, link: E2E_REPORT, attrs: { target: '_blank' } },
            { label: '更新记录', translations: { en: 'Releases' }, link: `${REPO}/releases`, attrs: { target: '_blank' } },
          ],
        },
      ],
    }),
  ],
})
