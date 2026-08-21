import type * as React from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@admin/ui/components/badge'
import { cn } from '@admin/ui/lib/utils'

/**
 * 状态色的**唯一定义处**。
 *
 * 这串 class 原先在 8 个文件里各手抄一遍，抄漏一次就出现「同一个状态在
 * 两个页面长得不一样」（数据字典的状态曾经退化成纯彩色文字，没有药丸底）。
 * 表格 / 详情 / 筛选一律从这里取。
 */
export type Tone = 'success' | 'danger' | 'warning' | 'info' | 'muted'

export const TONE_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-500/15 text-emerald-700 ring-emerald-500/30 dark:text-emerald-300',
  danger: 'bg-destructive/10 text-destructive ring-destructive/25',
  warning: 'bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:text-amber-300',
  info: 'bg-sky-500/10 text-sky-700 ring-sky-500/25 dark:text-sky-300',
  muted: 'bg-muted text-muted-foreground ring-border',
}

/** 通用状态药丸。文案由调用方给 —— 成功/失败、正常/停用语义不同但样式同源 */
export function StatusPill({
  tone,
  children,
  className,
  ...rest
}: React.ComponentProps<'span'> & { tone: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs ring-1',
        TONE_CLASS[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

// ─── 系统通用「正常 / 停用」 ────────────────────────────────────────────────────

export const STATUS_META: Record<number, { label: string; tone: Tone }> = {
  0: { label: '停用', tone: 'danger' },
  1: { label: '正常', tone: 'success' },
}

export function StatusBadge({ value }: { value: number }) {
  const { t } = useTranslation()
  const meta = STATUS_META[value] ?? STATUS_META[0]!
  // STATUS_META 是模块级常量，它的中文 label 直接就是翻译 key
  return <StatusPill tone={meta.tone}>{t(meta.label)}</StatusPill>
}

/** Base UI 的 Select 关闭态靠 items 映射显示标签，不传就会渲染原始 value */
export const STATUS_FILTER_ITEMS: Record<string, string> = {
  all: '全部状态',
  '1': '正常',
  '0': '停用',
}

/** 表单里的状态选项（没有「全部」） */
export const STATUS_FORM_ITEMS: Record<string, string> = { '1': '正常', '0': '停用' }

export const STATUS_OPTIONS = [
  { value: 1, label: '正常' },
  { value: 0, label: '停用' },
]

/** 布尔型 Badge：给「是否」类字段用 */
export function YesNoBadge({ value, yes, no }: { value: boolean; yes: string; no: string }) {
  const { t } = useTranslation()
  return (
    <Badge variant={value ? 'outline' : 'secondary'} className="font-normal">
      {t(value ? yes : no)}
    </Badge>
  )
}

/**
 * 抽取锚点 —— **永不调用**，只为让抽取器看见字面量。
 *
 * 上面那些常量（`STATUS_META` / `STATUS_FILTER_ITEMS` / …）的中文是在**渲染处**
 * 用 `t(变量)` 翻的（见 `StatusBadge` / `SelectFilter`）。
 * 而抽取器和 `i18n:check` 只认**字符串字面量** ——
 * 这是 GitLab i18n 文档里同样的硬规则（"always pass string literals to the helpers"），
 * 因为静态分析没法解析变量。
 *
 * 所以把这些文案在这里再列一遍。加新状态文案时记得同步，
 * 否则 `pnpm i18n:check` 不会提醒你漏翻。
 */
export function _i18nExtractionAnchors(t: (k: string) => string) {
  return [t('正常'), t('停用'), t('全部状态'), t('是'), t('否')]
}
