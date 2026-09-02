/**
 * 产品标识 —— **抄自 `apps/web/src/lib/brand.ts`，那边是唯一真相源。**
 * 抄而不是 import：`apps/mobile` 不在 `i18n ← ui ← platform ← apps/web` 那条箭头上。
 *
 * ⚠️ 那边改了名字/版本，这里要跟着改，不会自己报错。
 */
export const BRAND = {
  /** 挂在榫卯标记旁边的那个名字。web 端侧边栏顶部、登录页角标读的是同一个 */
  wordmark: 'fastapi-react-admin',
  tagline: 'FastAPI + React 19 中后台底座',
  version: 'v0.0.1',
  /** 应用显示名（launcher / 任务切换器）。`app.json` 的 `name` 也是它 */
  appName: '中后台',
} as const
