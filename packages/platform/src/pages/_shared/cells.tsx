import { IconDotsVertical } from '@tabler/icons-react'
import type * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime, type ServerTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

/**
 * 表格单元格的**唯一写法**（#210 P1-7 / P1-8）。
 *
 * 调研时同一种数据在各页有好几种长相：时间四种（蓝色等宽 / 灰色等宽 / 无衬线 /
 * 16px 黑色大字）、耗时两种（`52ms` 黑 14px / `7.0 ms` 灰 12px）、
 * 操作列四种（⋯ 菜单 / 裸图标 / 红字按钮 / 表头写「操作」底下是空的）。
 * 每页都是照兄弟页抄的，抄的那页不一样，结果就不一样 —— 所以收成组件。
 *
 * 约定：
 * - **蓝色 = 能点**。只有 `TimeCell` 给了 `onOpen` 才是主色 + 悬停下划线；
 *   不能点的时间一律灰色，免得用户去点一个不是链接的东西
 * - 空值一律 `—`（em dash），灰色
 */

/** 空值占位。表格里「没有」只用这一个字符 */
export const EMPTY = '—'

export function EmptyCell() {
  return <span className="text-muted-foreground">{EMPTY}</span>
}

const TIME_CLASS = 'font-mono text-xs whitespace-nowrap tabular-nums'

/**
 * 时间单元格。给 `onOpen` 就是「点时间看详情」的入口（日志类页面的约定，
 * 比单加一列「查看」省地方），否则是纯展示。
 */
export function TimeCell({
  value,
  onOpen,
  testId,
}: {
  value: ServerTime
  onOpen?: () => void
  testId?: string
}) {
  const text = formatDateTime(value)
  if (text === EMPTY) return <EmptyCell />
  if (onOpen) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onOpen}
        className={cn(TIME_CLASS, 'text-primary underline-offset-2 hover:underline')}
      >
        {text}
      </button>
    )
  }
  return (
    <span className={cn(TIME_CLASS, 'text-muted-foreground')} data-testid={testId}>
      {text}
    </span>
  )
}

/** `7.0 ms` · `52 ms` · `1.24 s`：10ms 以下留一位小数，1 秒以上换成秒 */
export function formatDuration(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)} ms`
  if (ms < 999.5) return `${Math.round(ms)} ms` // 不写 < 1000：999.6 会取整成「1000 ms」
  return `${(ms / 1000).toFixed(2)} s`
}

/** 耗时单元格。超过 `slowMs`（默认 500）标琥珀色 —— 那是用户唯一需要注意的情况 */
export function DurationCell({ ms, slowMs = 500 }: { ms: number | null | undefined; slowMs?: number }) {
  if (ms === null || ms === undefined) return <EmptyCell />
  return (
    <span
      className={cn(
        TIME_CLASS,
        ms > slowMs ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
      )}
    >
      {formatDuration(ms)}
    </span>
  )
}

/**
 * 行操作：一律收进 ⋯ 菜单，危险操作放菜单最后（前面加 `DropdownMenuSeparator`、
 * 用 `variant="destructive"`）。children 就是 `DropdownMenuItem`，
 * 所以 `<Can>` / `<SuperOnly>` 照旧包在单项外面。
 *
 * 列定义用 `id: 'actions'` —— `DataTable` 认这个 id，把这一列收到最窄、靠右。
 * 一行没有可做的操作时整格返回 `null`，别留一个点开是空的菜单。
 */
export function RowActions({
  label,
  testId,
  children,
  className,
}: {
  /** 读屏用：「操作 {{name}}」里的 name */
  label: string
  testId?: string
  children: React.ReactNode
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className={cn('size-7', className)}
            aria-label={t('操作 {{name}}', { name: label })}
          />
        }
        data-testid={testId}
      >
        <IconDotsVertical className="size-4" />
      </DropdownMenuTrigger>
      {/* 不写死宽度：各页菜单项长短不一（「强制下线」「查看调用日志」），原来 w-32 / w-36 / w-40 三种 */}
      <DropdownMenuContent align="end" className="w-auto min-w-36">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
