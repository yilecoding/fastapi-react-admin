// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// 🔴 站点挂在 GitHub Pages 的项目子路径下（yilecoding.github.io/fastapi-react-admin/），
// Astro 只给它自己生成的链接（侧边栏、上下篇、语言切换）补 base，**正文里手写的
// `/xxx/` 链接不补** —— 不补就是指向 yilecoding.github.io/xxx/ 的 404。
// 下面的 remark 插件把正文里以 `/` 开头的站内链接统一补上 base，写文档时照常写
// `/getting-started/quick-start/` 就行；换成自己的域名时只改 SITE / BASE 两行。
const SITE = 'https://yilecoding.github.io'
const BASE = '/fastapi-react-admin'

const REPO = 'https://github.com/yilecoding/fastapi-react-admin'

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
        'Open-source admin foundation on FastAPI + React 19 + shadcn/ui: row-level data permissions, multi-tab that keeps state, approval workflow, a permission-bound AI assistant, PostgreSQL / SQL Server / MySQL.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      // 主题和后台同一套：Inter / JetBrains Mono 自托管（不走 Google Fonts —— 国内打不开），品牌紫见 theme.css
      customCss: ['@fontsource-variable/inter', '@fontsource-variable/jetbrains-mono', './src/styles/theme.css'],
      // 首页 hero 换成登录页那套品牌面板 + 立体榫卯（src/components/Hero.astro）
      components: { Hero: './src/components/Hero.astro' },
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/apps/docs/` },
      // 每页显示「最后更新」—— 读 git 历史，所以 CI 里 checkout 要 fetch-depth: 0，
      // 浅克隆下每一页都会显示成「今天」
      lastUpdated: true,
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        'zh-cn': { label: '简体中文', lang: 'zh-CN' },
      },
      head: [
        // 链接分享到飞书 / Slack / X 时的卡片大图；Starlight 自己只出标题和描述
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE}${BASE}/og.png` } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: `${SITE}${BASE}/og.png` } },
      ],
      sidebar: [
        {
          label: 'Getting started',
          translations: { 'zh-CN': '开始' },
          items: [{ autogenerate: { directory: 'getting-started' } }],
        },
        {
          label: 'Features',
          translations: { 'zh-CN': '功能' },
          items: [{ autogenerate: { directory: 'features' } }],
        },
        {
          label: 'Links',
          translations: { 'zh-CN': '链接' },
          items: [
            { label: 'Live demo', translations: { 'zh-CN': '在线演示' }, link: 'https://fra.wubunan.com/sign-in', attrs: { target: '_blank' } },
            { label: 'E2E report', translations: { 'zh-CN': 'E2E 报告' }, link: `${SITE}${BASE}/e2e/`, attrs: { target: '_blank' } },
            { label: 'Releases', translations: { 'zh-CN': '更新记录' }, link: `${REPO}/releases`, attrs: { target: '_blank' } },
          ],
        },
      ],
    }),
  ],
})
