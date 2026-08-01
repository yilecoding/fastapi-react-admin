/**
 * app 侧的 i18n 接线层 —— **薄的一层**。
 *
 * 语言包、i18next 实例、校验脚本都在 `packages/i18n`（结构参照 Rocket.Chat
 * 的 `packages/i18n`）。那个包是新的最底层，**不允许依赖任何 workspace 包**，
 * 所以「切语言时同步接口的 Accept-Language」这种副作用只能在这里挂 ——
 * 它要 import platform 的 api-client。
 */
import { initReactI18next } from 'react-i18next'

import { setApiLanguage } from '@admin/platform/api-client/client'
import { initI18n, onLanguageChange, readStoredLanguage, t } from '@admin/i18n'

import { BRAND } from '@/lib/brand'

// 后端按 Accept-Language 翻译响应 msg（见 backend/common/i18n.py: tm）。
// 不同步的话界面是英文、接口报错还是中文，看起来像坏了。
onLanguageChange((lang) => setApiLanguage(lang))
setApiLanguage(readStoredLanguage())

// React 绑定在这里注入 —— packages/i18n 是框架无关的（见那边的注释）
initI18n([initReactI18next])

/*
 * 浏览器标签页标题。`index.html` 里那句是写死的中文，切语言不会动 ——
 * 界面全英文、标签页还写着中文，是最容易被忽略的一处（agent 审计时发现的）。
 * 挂在这里而不是某个页面组件里：它是「整个 app 一份」的，和路由无关。
 */
const syncDocumentTitle = (): void => {
  document.title = t(BRAND.tagline)
}
onLanguageChange(syncDocumentTitle)
syncDocumentTitle()

export { LANGUAGES, changeLanguage, currentLanguage, menuKey } from '@admin/i18n'
export type { Language } from '@admin/i18n'
