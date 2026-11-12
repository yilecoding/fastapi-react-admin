// 只调整信息分类，不移动内容文件：旧的页面 URL 继续有效。
// 每篇文章必须且只能属于一个分类；astro.config.mjs 在构建时核对中英两份内容。
export const DOC_SECTIONS = [
  {
    label: '入门指南', en: 'Getting started',
    pages: ['getting-started/introduction', 'getting-started/quick-start'],
  },
  {
    label: '功能指南', en: 'Features',
    pages: [
      'features/overview', 'features/login-security', 'features/login-sessions', 'features/rbac',
      'features/data-permissions', 'features/audit-logs', 'features/workspace',
      'features/multi-tab', 'features/approval-workflow', 'features/notifications',
      'features/import-export', 'features/file-storage', 'features/ai-assistant',
      'features/clients',
    ],
  },
  {
    label: '开发指南', en: 'Development',
    pages: [
      'guides/project-structure', 'guides/first-module', 'features/developer-tools', 'features/plugins', 'features/open-api',
    ],
  },
  {
    label: '部署运维', en: 'Operations',
    pages: [
      'getting-started/deployment', 'features/databases', 'features/config-dict', 'reference/security-config',
      'features/scheduler', 'features/monitoring', 'reference/upgrade',
    ],
  },
  {
    label: '常见问题', en: 'FAQ',
    pages: ['reference/faq'],
  },
]

export const DOC_LINKS = [
  { label: '在线演示', en: 'Live demo', href: 'https://fra.wubunan.com/sign-in' },
  { label: 'E2E 报告', en: 'E2E report', href: 'https://yilecoding.github.io/fastapi-react-admin/e2e/' },
  { label: '更新记录', en: 'Releases', href: 'https://github.com/yilecoding/fastapi-react-admin/releases' },
]
