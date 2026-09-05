import { useTranslation } from "react-i18next"

/**
 * `packages/ui` 唯一的翻译入口。**组件里不要直接 `useTranslation()`。**
 *
 * ## 为什么要这一层
 *
 * 本包的定位是「被下游整包拿走自己改」（见 `PORTING.md`），而翻译实例是
 * **app 层注入**的：`packages/i18n` 建实例、`apps/web/src/i18n.ts` 用
 * `initI18n([initReactI18next])` 把 React 绑定接上去。**只拿 ui 不接这条线**
 * （或者接了但忘了 `initReactI18next`）时，`react-i18next` 会绑到它自己的空
 * 实例上，`t()` 原样返回 key。
 *
 * 本仓库「中文原文即 key」（见 [i18n 分册](../../../i18n/AGENTS.md)），所以
 * 这个失效**看起来是好的** —— 满屏中文，一切正常。坏掉的只有插值：
 *
 * | | 有实例 | 无实例（裸 react-i18next） | 无实例（本文件兜底） |
 * |---|---|---|---|
 * | `t('重试')` | 重试 | 重试 | 重试 |
 * | `t('共 {{total}} 条', {total: 42})` | 共 42 条 | **`共 {{total}} 条`** | 共 42 条 |
 *
 * 中间那一列就是分页条上真的出现过的样子（实测踩过，见 i18n 分册）。
 * 它是最难归因的一种坏法：不报错、不缺元素、99% 的文案都对，
 * 只有带数字的那几条显示成模板源码 —— 看着像「这条文案写错了」。
 *
 * 所以本包**自带**一个只做插值的兜底 `t`。接了实例走实例（拿到真译文），
 * 没接就回落到「key 原样 + 插值」—— 下游拿走 ui 什么都不接也是一个
 * 中文界面正常、插值正确的库，而不是一个 20 处显示 `{{n}}` 的库。
 */

/** react-i18next 没有实例时的 `t`：原样返回 key，但**做插值** */
function interpolateOnly(key: string, opts?: Record<string, unknown>): string {
  if (!opts) return key
  // 只认 {{name}} 这一种占位符（i18next 的默认 prefix/suffix）
  return key.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
    const v = opts[name]
    return v === undefined || v === null ? whole : String(v)
  })
}

export type TFn = (key: string, opts?: Record<string, unknown>) => string

/**
 * 取翻译函数。签名刻意收窄成 `(key, opts?) => string` ——
 * 本包只用得到这一种形态，收窄之后兜底实现才可能和真实例等价替换。
 */
export function useT(): TFn {
  const { t, i18n } = useTranslation()
  // 没有实例时 react-i18next 返回的 `i18n` 是个空对象（不是 undefined），
  // 所以判据用 `isInitialized` 而不是 `i18n == null`
  if (!i18n?.isInitialized) return interpolateOnly
  return t as TFn
}

/** 兜底实现单独导出，给单测用 */
export const __fallbackT = interpolateOnly
