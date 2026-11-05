/**
 * 产品标识 —— **抄自 `apps/web/src/lib/brand.ts`，那边是唯一真相源。**
 * 抄而不是 import：`apps/mobile` 不在 `i18n ← ui ← platform ← apps/web` 那条箭头上。
 *
 * ⚠️ 那边改了名字，这里要跟着改，不会自己报错。
 *
 * 🔴 **版本号不抄 web 的**：移动端是单独装的 App、和 web 不同步发版，单独编号（#234）。
 * 它从 `app.json` 读 —— 原来在这里手写一份 `'v0.0.1'`，和 `app.json` 是同一个 App 里的两份真相源，
 * 改一处忘一处时设置页 / 登录页显示的版本和安装包对不上（web 那边 `hardcoded-version` 守的是同一件事）。
 */
import appJson from '../../app.json'

export const BRAND = {
  /** 挂在榫卯标记旁边的那个名字。web 端侧边栏顶部、登录页角标读的是同一个 */
  wordmark: 'fastapi-react-admin',
  tagline: 'FastAPI + React 19 中后台底座',
  version: `v${appJson.expo.version}`,
  /** 应用显示名（launcher / 任务切换器）。`app.json` 的 `name` 也是它 */
  appName: '中后台',
  /** 底座里真正承重的那几样。登录页页脚会把它列出来 —— 和 web 端同一份 */
  stack: ['REACT 19', 'TANSTACK', 'SHADCN', 'TAILWIND', 'FASTAPI'],
} as const
