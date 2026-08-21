import i18next from 'i18next'

import enUS from './locales/en-US.json'
import zhCN from './locales/zh-CN.json'

/**
 * 多语言包。结构参照 Rocket.Chat 的 `packages/i18n`（`@rocket.chat/i18n`）：
 * 语言文件、i18next 实例、校验脚本都收在**一个独立包**里，
 * 而不是散在最上层的 app 里 —— 因为文案来自 `ui` / `platform` / `web` 三层，
 * 放在 app 里会让最底层的 `ui` 的文案存在最上层，分层就反了。
 *
 * 依赖方向：**`i18n` ← `ui` ← `platform` ← `web`**，本包是新的最底层，
 * 所以它**不能**依赖任何 workspace 包（连 platform 的 api-client 都不行）。
 * 需要副作用（如同步接口的 Accept-Language）的一律走 `onLanguageChange()` 订阅，
 * 由上层注册。
 *
 * ── key 策略：中文原文即 key ──
 *
 * 这是 GitLab（gettext，英文原文即 msgid）和 VS Code（`l10n.t()`）的路线。
 * **刻意不抄 Rocket.Chat 的 `Department_name` 式符号 key** —— 那是他们
 * 英文优先的结果而不是独立最佳实践（他们的 zh-CN 也只是英文的译文）。
 * 我们中文优先，符号 key 会把「漏一条 zh 条目 → 屏幕上出现 raw key」
 * 变成常态失败模式。
 *
 * `zh-CN.json` 是**恒等映射**（key 与值都是中文）。放它的意义：
 *   - 文案有一处可集中修改（产品/译者不用翻代码）
 *   - 最坏情况（漏条目）也只是回落到 key，而 key 本身就是中文 —— 不难看
 */

export const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
] as const

export type Language = (typeof LANGUAGES)[number]['value']

/** 基准语言：所有其他语言都是它的译文，校验脚本以它为准 */
export const BASE_LANGUAGE: Language = 'zh-CN'

const STORAGE_KEY = 'admin:language'

/** 语言是**用户偏好**而不是会话状态，所以用 localStorage（tab 栈才是 sessionStorage） */
export function readStoredLanguage(): Language {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return LANGUAGES.some((l) => l.value === v) ? (v as Language) : BASE_LANGUAGE
  } catch {
    return BASE_LANGUAGE
  }
}

type Listener = (lang: Language) => void
const listeners = new Set<Listener>()

/**
 * 订阅语言变化。给上层挂副作用用 —— 典型是同步接口的 `Accept-Language`
 * （后端按它翻译响应 `msg`，不同步的话界面英文、报错中文，看起来像坏了）。
 */
export function onLanguageChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 初始化。`plugins` 由调用方传 —— 本包**刻意不依赖 react-i18next**
 * （Rocket.Chat 的 i18n 包同样是框架无关的），React 绑定
 * (`initReactI18next`) 在 `apps/web/src/i18n.ts` 里注入。
 *
 * ⚠️ 忘了注入的后果很隐蔽：`useTranslation()` 会绑到 react-i18next
 * **自己的默认实例**上，那个实例没有任何 resources，于是 `t()` 原样返回 key ——
 * 界面看起来「全是中文」（因为 key 就是中文），连 `{{n}}` 插值都不做，
 * 分页条会直接显示 `共 {{total}} 条`。实测踩过。
 */
export function initI18n(plugins: Parameters<typeof i18next.use>[0][] = []): typeof i18next {
  const lng = readStoredLanguage()
  for (const p of plugins) i18next.use(p)
  void i18next.init({
    lng,
    fallbackLng: BASE_LANGUAGE,
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS },
    },

    // ⚠️ 这两行是「中文原文即 key」能不能跑的关键，删了会静默出错：
    //   keySeparator 默认 '.' —— 文案里有 `smtp.qq.com`、`README.md`、
    //     `apps/web/src/routes`，会被切成嵌套路径然后查不到
    //   nsSeparator  默认 ':' —— 文案里有 `最后更新 14:58`、`sys:user:add`，
    //     还有菜单 key 的 `menu:/system/dept` 前缀，会被当成「命名空间:key」
    keySeparator: false,
    nsSeparator: false,

    interpolation: { escapeValue: false }, // React 自己转义
    returnEmptyString: false, // 空串视为未翻译 → 回落到 key（中文）
  })
  notify(lng)
  return i18next
}

function notify(lang: Language): void {
  document.documentElement.lang = lang
  for (const fn of listeners) fn(lang)
}

export async function changeLanguage(lang: Language): Promise<void> {
  await i18next.changeLanguage(lang)
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* 隐私模式下写不进去，内存态仍然生效 */
  }
  notify(lang)
}

export function currentLanguage(): Language {
  return (i18next.language as Language) ?? BASE_LANGUAGE
}

/**
 * 菜单标题的 key。**用 path 而不是标题本身**：
 * 标题存在数据库里，管理员随时能改，改了英文条目就失效；
 * 而 path 是从前端真实路由下拉选的，是这套数据里最稳的东西。
 *
 * 用法：`t(menuKey(node.path), { defaultValue: node.title })`
 * —— 查不到就回落到库里的中文标题，**永远不会在界面上露出 raw key**。
 */
export function menuKey(path: string | null | undefined): string {
  return `menu:${path ?? ''}`
}

// ─── 本地化格式化 ─────────────────────────────────────────────────────────────

/**
 * 数字千分位。**跟随当前界面语言**，不要写死 `'zh-CN'`。
 *
 * 中英分组符号一样（都是 `,`），但语言不该在代码里被钉死 ——
 * 将来加德语（`1.234.567`）或印度英语（`12,34,567`）时，
 * 写死的那几处会成为唯一漏掉的地方。
 */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—'
  return n.toLocaleString(currentLanguage())
}

/** 时刻（不含日期）。24 小时制在中文下是习惯，英文下交给 locale 自己决定 */
export function formatTime(at: number | Date): string {
  const lang = currentLanguage()
  return new Date(at).toLocaleTimeString(lang, lang === 'zh-CN' ? { hour12: false } : undefined)
}

/**
 * 时长（运行时长这类）。**入参是秒数，不是拼好的句子** ——
 * 后端原先在 `utils/format.py` 里就把「3 天 5 小时」拼成中文了，
 * 那样切到英文界面时这一格永远是中文。接口现在下发 `*_seconds`，成句在这里做。
 *
 * 只取最高两级（`3 天 5 小时`，不带分钟），不足一分钟显示秒 —— 刚重启的服务
 * 才不会一直显示 0。
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—'
  const total = Math.max(0, Math.floor(seconds))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (d) parts.push(i18next.t('{{n}} 天', { n: d }) as string)
  if (h) parts.push(i18next.t('{{n}} 小时', { n: h }) as string)
  if (!d && m) parts.push(i18next.t('{{n}} 分钟', { n: m }) as string)
  return parts.length ? parts.join(' ') : (i18next.t('{{n}} 秒', { n: s }) as string)
}

/** 日期（不含时刻） */
export function formatDate(at: number | Date): string {
  return new Date(at).toLocaleDateString(currentLanguage())
}

/**
 * 非 React 模块用的翻译函数（api.ts、工具函数、抛异常的地方）。
 *
 * 它读的是**调用瞬间**的语言，不订阅变更 —— 所以只能用在
 * 「每次都会重新调用」的位置：事件回调里抛的错误、render 期间算的派生文案。
 * 组件里的静态文案一律用 `useTranslation()`，否则切语言时不会重渲染。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  return i18next.t(key, vars ?? {}) as string
}

export { i18next }
