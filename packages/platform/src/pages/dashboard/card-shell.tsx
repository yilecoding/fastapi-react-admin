import * as React from 'react'

import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'

/**
 * 工作台卡片的**外壳** —— 全部卡片共用这一份（#202）：标题行、动作区、加载 / 错误 / 空态。
 *
 * 卡片自己（`cards/*.tsx`）只管取数和内容，长相全在这里：以后整体换皮只动这一个文件，
 * testid 由 `testId` 派生（`-error` / `-loading` / `-empty`），换皮不会动它们。
 *
 * 状态的先后（同列表页 `listState` 那套口径）：
 * - **错误优先**：`error` 一律画错误块 + 重试（硬纪律 9：失败不能长成空态 / 一排「—」）
 * - 已经有上一次成功的数据时（`hasData`），错误块挂在上面、内容留着 —— 别把用户正在看的东西抽走
 * - 加载中画骨架，`empty` 画空态文案
 */
export function DashboardCard({
  title,
  icon,
  note,
  action,
  testId,
  loading = false,
  error,
  onRetry,
  hasData = false,
  empty = false,
  emptyText,
  children,
}: {
  title: string
  icon?: React.ReactNode
  /** 标题旁边的小字（统计口径、条数） */
  note?: React.ReactNode
  /** 右上角（「全部」链接之类） */
  action?: React.ReactNode
  testId: string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  hasData?: boolean
  empty?: boolean
  emptyText?: string
  children?: React.ReactNode
}) {
  const titleId = React.useId()
  const failed = Boolean(error)
  const showBody = !failed || hasData

  return (
    <section
      className="flex h-full min-w-0 flex-col gap-3 rounded-lg border border-border px-4 py-3"
      data-testid={testId}
      aria-labelledby={titleId}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id={titleId} className="flex items-center gap-1.5 text-sm font-medium">
            {icon}
            {title}
          </h2>
          {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
        </div>
        {action}
      </div>

      {failed && <QueryError error={error} onRetry={onRetry} testId={`${testId}-error`} />}

      {showBody &&
        (loading ? (
          <div className="flex flex-col gap-2" data-testid={`${testId}-loading`}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        ) : empty ? (
          <p className="py-6 text-center text-sm text-muted-foreground" data-testid={`${testId}-empty`}>
            {emptyText}
          </p>
        ) : (
          children
        ))}
    </section>
  )
}

/** 卡片右上角的「全部」那种小链接的样式（`<Link>` 由卡片自己给，样式统一在这里） */
export const CARD_ACTION_CLASS = 'shrink-0 text-xs text-primary underline-offset-2 hover:underline'

/** 卡片里的列表行（`<li>` 内层）的样式 */
export const CARD_ROW_CLASS =
  'flex w-full items-center gap-2 rounded-sm py-1.5 text-start text-sm transition-colors hover:bg-muted/50'
