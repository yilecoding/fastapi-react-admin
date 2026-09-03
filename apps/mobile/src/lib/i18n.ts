import * as Localization from 'expo-localization'
import * as SecureStore from 'expo-secure-store'
import { initReactI18next } from 'react-i18next'

import {
  BASE_LANGUAGE,
  LANGUAGES,
  type Language,
  changeLanguage as changeI18nLanguage,
  initI18n,
  onLanguageChange,
} from '@admin/i18n'

/**
 * 移动端的 i18n 接线层 —— **薄的一层**，和 `apps/web/src/i18n.ts` 对称。
 *
 * 语言包、i18next 实例、校验脚本都在 `packages/i18n`。那个包是最底层、
 * **框架无关**（连 `react-i18next` 都不依赖），所以 React 绑定和所有副作用
 * （持久化、同步 `Accept-Language`）都在这里挂。
 *
 * 🔴 **`packages/i18n` 里原来有一句 `document.documentElement.lang = lang`。**
 * 那是 web-only 的副作用，而 RN **没有 `document`** —— 留着它移动端一初始化
 * 就抛异常。已经挪到 `apps/web/src/i18n.ts` 的订阅里去了。
 * 以后往那个包里加东西，**先问一句「RN 上有这个 API 吗」**。
 *
 * 🔴 **`readStoredLanguage()` 在 RN 上恒定返回基准语言** —— 它读 `localStorage`，
 * RN 没有，会走 catch 分支。**不报错但也永远读不到用户的选择**。
 * 所以移动端自己持久化（`expo-secure-store`），并把初值传给 `initI18n`。
 */
const KEY = 'admin.language'

function isLanguage(v: unknown): v is Language {
  return LANGUAGES.some((l) => l.value === v)
}

/**
 * 设备语言 —— 用户第一次装 App、还没选过语言时的初值。
 *
 * ⚠️ `getLocales()[0]` 可能是 `zh-Hant-TW`、`en-GB` 这种带地区的标签，
 * 而我们只有 `zh-CN` / `en-US` 两个。所以**按语言主段落匹配**，
 * 匹配不到回落到基准语言 —— 不要拿完整标签去比，那样 `en-GB` 会被判成"不支持"
 * 然后给一个中文界面。
 */
function deviceLanguage(): Language {
  const tag = Localization.getLocales()[0]?.languageTag ?? ''
  const primary = tag.split('-')[0]?.toLowerCase()
  if (primary === 'zh') return 'zh-CN'
  if (primary === 'en') return 'en-US'
  return BASE_LANGUAGE
}

/** 冷启动读回用户选过的语言；没选过就用设备语言 */
async function readStored(): Promise<Language> {
  try {
    const v = await SecureStore.getItemAsync(KEY)
    if (isLanguage(v)) return v
  } catch {
    // 读不出来就当没选过
  }
  return deviceLanguage()
}

/**
 * 初始化。
 *
 * ⚠️ 必须在渲染任何用到 `t()` 的东西**之前**跑完。忘了注入 `initReactI18next`
 * 的后果很隐蔽：`useTranslation()` 会绑到 react-i18next **自己的默认实例**上，
 * 那个实例没有任何 resources，于是 `t()` 原样返回 key —— 界面看起来「全是中文」
 * （因为 key 就是中文），连 `{{n}}` 插值都不做（`packages/i18n` 里记着这次实测）。
 */
export async function setupI18n(): Promise<void> {
  const lng = await readStored()
  initI18n([initReactI18next], lng)

  // 语言变了要落盘。`packages/i18n` 的 `changeLanguage` 会写 localStorage，
  // 在 RN 上那句进 catch 被忽略 —— 真正的持久化只有这里
  onLanguageChange((lang) => {
    void SecureStore.setItemAsync(KEY, lang).catch(() => {
      // 存不下只影响下次冷启动，本次会话仍然生效
    })
  })
}

export { LANGUAGES, changeI18nLanguage as changeLanguage }
export type { Language }
