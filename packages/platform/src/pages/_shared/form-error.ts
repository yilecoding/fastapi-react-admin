import * as React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 表单校验信息的翻译钩子。
 *
 * zod schema 是模块级常量（`z.string().min(1, '请输入用户名')`），拿不到 hook，
 * 所以报错文案没法在定义处过 `t()`。但我们的 key 就是中文原文本身，
 * 于是在**渲染处**翻译就够了 —— schema 一个字都不用改。
 *
 * ```tsx
 * const fe = useFieldError()
 * <Field label={t('用户名')} error={fe(errs.username?.message)} />
 * ```
 *
 * 传进来的 message 若不在语言包里，i18next 会原样返回（`returnEmptyString: false`），
 * 也就是退化成中文原文 —— 不会出现空白报错。
 */
export function useFieldError() {
  const { t } = useTranslation()
  return React.useCallback((msg?: string | null) => (msg ? t(msg) : undefined), [t])
}
