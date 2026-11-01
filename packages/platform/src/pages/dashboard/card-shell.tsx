import * as React from 'react'

import { QueryError } from '@admin/ui/components/query-error'
import { Skeleton } from '@admin/ui/components/skeleton'
import { cn } from '@admin/ui/lib/utils'

/**
 * 工作台卡片的**外壳** —— 全部卡片共用这一份（#202）：标题行、动作区、加载 / 错误 / 空态。
 *
 * 卡片自己（`cards/*.tsx`）只管取数和内容，长相全在这里：以后整体换皮只动这一个文件，
 * testid 由 `testId` 派生（`-error` / `-loading` / `-empty`），换皮不会动它们。
 *
 * 两种排法（设计稿 `Todo.dc.html`）：
 * - `panel`：标题栏单独一行、下面一条分隔线，内容贴边（「待我处理」「我发起的」「需要你留意」这类列表）
 * - `tile`：标题和内容在同一块内边距里（下面一排三张小卡）
 *
 * 状态的先后（同列表页 `listState` 那套口径）：
 * - **错误优先**：`error` 一律画错误块 + 重试（硬纪律 9：失败不能长成空态 / 一排「—」）
 * - 已经有上一次成功的数据时（`hasData`），错误块挂在上面、内容留着 —— 别把用户正在看的东西抽走
 * - 加载中画骨架，`empty` 画空态文案
 */
export function DashboardCard({
  title,
  subtitle,
  badge,
  headerExtra,
  action,
  footer,
  variant = 'panel',
  testId,
  loading = false,
  error,
  onRetry,
  hasData = false,
  empty = false,
  emptyText,
  emptyIcon,
  children,
}: {
  title: string
  /** 标题下面一行小字（「每天登录成功与失败次数」） */
  subtitle?: string
  /** 标题后面的小数字 / 小标签 */
  badge?: React.ReactNode
  /** 标题和右侧动作之间（分段标签放这里） */
  headerExtra?: React.ReactNode
  /** 右上角（「全部」链接之类） */
  action?: React.ReactNode
  /** 底部一行（只在有内容时画） */
  footer?: React.ReactNode
  variant?: 'panel' | 'tile'
  testId: string
  loading?: boolean
  error?: unknown
  onRetry?: () => void
  hasData?: boolean
  empty?: boolean
  emptyText?: string
  emptyIcon?: React.ReactNode
  children?: React.ReactNode
}) {
  const titleId = React.useId()
  const failed = Boolean(error)
  const showBody = !failed || hasData
  const tile = variant === 'tile'
  const pad = tile ? '' : 'px-5'

  const body = showBody ? (
    loading ? (
      <div className={cn('flex flex-col gap-2', tile ? '' : 'px-5 py-4')} data-testid={`${testId}-loading`}>
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    ) : empty ? (
      <div
        className={cn('flex flex-col items-center gap-2 text-center text-sm text-muted-foreground', tile ? 'py-4' : 'px-5 py-10')}
        data-testid={`${testId}-empty`}
      >
        {emptyIcon}
        <p>{emptyText}</p>
      </div>
    ) : (
      children
    )
  ) : null

  return (
    <section
      className={cn(
        'flex h-full min-w-0 flex-col rounded-[14px] border border-border bg-card text-card-foreground shadow-xs',
        tile && 'gap-3.5 px-5 py-[18px]'
      )}
      data-testid={testId}
      aria-labelledby={titleId}
    >
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-3 gap-y-2',
          tile ? '' : 'border-b border-border/60 py-4',
          pad
        )}
      >
        {subtitle ? (
          <span className="flex flex-col gap-1">
            <h2 id={titleId} className={cn('font-extrabold tracking-tight', tile ? 'text-[15px]' : 'text-base')}>
              {title}
            </h2>
            <span className="text-[12.5px] text-muted-foreground">{subtitle}</span>
          </span>
        ) : (
          <h2 id={titleId} className={cn('font-extrabold tracking-tight', tile ? 'text-[15px]' : 'text-base')}>
            {title}
          </h2>
        )}
        {badge}
        {headerExtra}
        <span className="flex-1" />
        {action}
      </div>

      {failed && (
        <div className={tile ? '' : 'px-5 pt-4'}>
          <QueryError error={error} onRetry={onRetry} testId={`${testId}-error`} />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">{body}</div>

      {footer && showBody && !loading && !empty && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted-foreground',
            tile ? '' : 'border-t border-border/60 px-5 pt-3 pb-3.5'
          )}
        >
          {footer}
        </div>
      )}
    </section>
  )
}

/** 卡片右上角的「全部」那种链接的样式（`<Link>` / `<button>` 由卡片自己给，样式统一在这里） */
export const CARD_ACTION_CLASS =
  'shrink-0 text-[13px] font-semibold text-primary underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50'

/** 标题后面的数字小胶囊 */
export function CountBadge({ n, tone = 'muted', testId }: { n: number; tone?: 'muted' | 'warning'; testId?: string }) {
  return (
    <span
      className={cn(
        'min-w-5 rounded-full px-1.5 text-center text-xs leading-5 font-bold tabular-nums',
        tone === 'warning'
          ? 'bg-orange-100 text-orange-800 dark:bg-orange-500/15 dark:text-orange-300'
          : 'bg-muted text-muted-foreground'
      )}
      data-testid={testId}
    >
      {n}
    </span>
  )
}

/** 人名头像：取名字最后一个字，底色按名字定（同一个人每次同一种颜色） */
const AVATAR_TONES = [
  'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-200',
  'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-200',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200',
  'bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-200',
  'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-200',
  'bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-200',
]

export function avatarTone(name: string): string {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0
  return AVATAR_TONES[h % AVATAR_TONES.length]!
}

export function NameAvatar({ name, size = 40, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const text = name ? Array.from(name).at(-1) : '?'
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded-full font-bold',
        name ? avatarTone(name) : 'bg-muted text-muted-foreground',
        className
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden
    >
      {text}
    </span>
  )
}
