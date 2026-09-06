import type * as React from 'react'

import { CopyButton } from '@admin/ui/components/copy-button'
import { Separator } from '@admin/ui/components/separator'
import { useTranslation } from 'react-i18next'

/**
 * 详情抽屉的两块公共积木。
 *
 * 键值行本身在 `ui/components/descriptions`（`Descriptions` / `DescriptionItem`）——
 * 那是通用原语。这里只放**详情抽屉专属**的两件：分节标题、ID 行。
 *
 * 🔴 为什么不复用 `form-fields.tsx` 的 `FormSection`：长得一模一样，
 * 但它渲染成 `<fieldset><legend>`，读屏会念「xxx 分组」并把里面的内容当成
 * **表单控件的集合**。只读详情里没有控件，语义是错的 —— 所以这里是
 * `<section><h3>`，视觉共用同一段 class。
 */
export function DetailSection({
  title,
  children,
}: {
  title: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        {/* 强调条用 bg-primary，跟着主题色走 —— 换主色它跟着变，不写死蓝 */}
        <span className="h-3.5 w-[3px] shrink-0 rounded-full bg-primary" aria-hidden />
        <span className="shrink-0">{title}</span>
        <Separator className="ms-1 min-w-0 flex-1" />
      </h3>
      {children}
    </section>
  )
}

/**
 * 雪花 ID / UUID 这类「必须能完整复制、但没人会去读」的值。
 *
 * 和 `DescriptionItem` 的区别是它**默认带复制按钮**且值渲染成 `<code>` ——
 * 这些值存在的唯一用途就是被粘到别处（工单、日志检索），
 * 所以复制按钮不是可选项。
 */
export function DetailIdRow({
  label,
  value,
  testId,
  labelWidth = 'w-20',
}: {
  label: string
  value: string
  testId?: string
  labelWidth?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2">
      <span className={`${labelWidth} shrink-0 text-xs text-muted-foreground`}>{label}</span>
      <code
        className="min-w-0 flex-1 truncate font-mono text-xs tabular-nums"
        title={value}
        data-testid={testId}
      >
        {value}
      </code>
      <CopyButton text={value} label={t('复制{{what}}', { what: label })} />
    </div>
  )
}
