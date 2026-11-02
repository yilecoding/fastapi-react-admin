import { IconDotsVertical } from '@tabler/icons-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'

import { formatDateTime, toEpochMs, type ServerTime } from '@admin/i18n'
import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { cn } from '@admin/ui/lib/utils'

import { usePerm } from '../../auth/use-perm'

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
 * - 空值一律灰色 `—`（`EmptyCell`）。accessor 里别写 `?? '—'`：那样是前景色的黑「—」
 */

export function EmptyCell() {
  return <span className="text-muted-foreground">—</span>
}

const TIME_CLASS = 'font-mono text-xs whitespace-nowrap tabular-nums'

/**
 * 时间单元格。给 `onOpen` 就是「点时间看详情」的入口（日志类页面的约定，
 * 比单加一列「查看」省地方），否则是纯展示。
 *
 * 🔴 **有 `onOpen` 时，时间为空也要渲染成能点的「—」。** 执行记录页的详情入口就挂在
 * `date_done` 上，而 Celery 对执行中 / 重试中的任务不写它 —— 空了就返回纯文本的话，
 * 这些行整行没有入口，正在重试的任务恰恰最需要看异常栈（#213 评审）。
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
  // 判空看能不能解析，不拿格式化结果去比占位符 —— 那是 datetime.ts 的内部细节
  const empty = toEpochMs(value) === null
  if (onOpen) {
    return (
      <button
        type="button"
        data-testid={testId}
        onClick={onOpen}
        className={cn(TIME_CLASS, 'text-primary underline-offset-2 hover:underline')}
      >
        {formatDateTime(value)}
      </button>
    )
  }
  if (empty) return <EmptyCell />
  return (
    <span className={cn(TIME_CLASS, 'text-muted-foreground')} data-testid={testId}>
      {formatDateTime(value)}
    </span>
  )
}

/**
 * 毫秒数 → `7.0 ms` · `52 ms` · `1.24 s`：10ms 以下留一位小数，1 秒以上换成秒。
 *
 * 不叫 `formatDuration`：`@admin/i18n` 里已经有一个同名的、收**秒**数（`25 分钟`），
 * 自动导入挑错一个就差 1000 倍还不报错。
 * 两道阈值都按「舍入后」判：写成 `< 10` / `< 1000` 的话，9.96 显示成「10.0 ms」、
 * 999.6 显示成「1000 ms」，同一列两种写法。
 */
export function formatMs(ms: number): string {
  if (ms < 9.95) return `${ms.toFixed(1)} ms`
  if (ms < 999.5) return `${Math.round(ms)} ms`
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
      {formatMs(ms)}
    </span>
  )
}

export type RowAction = {
  key: string
  label: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  onClick?: () => void
  /** 渲染成别的元素（如 `<Link>`），同 Base UI 的 `render` */
  render?: React.ReactElement
  /** 要这个权限码才显示 */
  perm?: string
  /** 只给超管（后端是 `DependsSuperUser`、没有权限码的那类） */
  superOnly?: boolean
  /** 按行数据决定不显示 */
  hidden?: boolean
  disabled?: boolean
  /** 危险操作：红色、排在最后、前面一条分隔线 */
  danger?: boolean
  /** 普通项里另起一组：前面画一条分隔线（过滤后它是第一项就不画）。
   *  Webhook 的「批量重发」和「编辑 / 重置签名密钥」要分开，挨着容易点错（#221 评审） */
  separatorBefore?: boolean
  testId?: string
}

/**
 * 行操作：一律收进 ⋯ 菜单。
 *
 * 用数据描述而不是 children：原来写成 `<Can>` 包着 `DropdownMenuItem`，组件看不见哪些项
 * 最后真的渲染了 —— 没有任何权限的人点开是一个**空浮层**，只有删除权限的人菜单顶上是一条
 * **孤立的分隔线**（#213 评审）。现在按权限过滤完：一项不剩就整格返回 `null`；
 * 危险项永远排最后，前面确实有普通项时才画分隔线。
 *
 * 列定义用 `id: ACTIONS_COLUMN_ID`（`@admin/ui/components/data-table`），`DataTable` 认它，
 * 把这一列收到按内容宽、靠右。
 */
export function RowActions({
  label,
  testId,
  items,
  triggerClassName,
}: {
  /** 读屏用：「操作 {{name}}」里的 name */
  label: string
  testId?: string
  items: RowAction[]
  /** 触发按钮的额外样式（主从页左栏、参数配置行要「悬停才显形」） */
  triggerClassName?: string
}) {
  const { t } = useTranslation()
  const { can, isSuperuser } = usePerm()
  const visible = items.filter(
    (i) => !i.hidden && (!i.superOnly || isSuperuser) && (!i.perm || can(i.perm))
  )
  if (!visible.length) return null
  const normal = visible.filter((i) => !i.danger)
  const danger = visible.filter((i) => i.danger)
  const item = (i: RowAction) => {
    const Icon = i.icon
    return (
      <DropdownMenuItem
        key={i.key}
        variant={i.danger ? 'destructive' : 'default'}
        disabled={i.disabled}
        onClick={i.onClick}
        render={i.render}
        data-testid={i.testId}
      >
        {Icon ? <Icon className="size-4" /> : null}
        {i.label}
      </DropdownMenuItem>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon" className={cn('size-7', triggerClassName)} aria-label={t('操作 {{name}}', { name: label })} />}
        data-testid={testId}
      >
        <IconDotsVertical className="size-4" />
      </DropdownMenuTrigger>
      {/* 不写死宽度：各页菜单项长短不一（「强制下线」「查看调用日志」），原来 w-32 / w-36 / w-40 三种 */}
      <DropdownMenuContent align="end" className="w-auto min-w-36">
        {normal.map((i, idx) => (
          <React.Fragment key={i.key}>
            {i.separatorBefore && idx > 0 ? <DropdownMenuSeparator /> : null}
            {item(i)}
          </React.Fragment>
        ))}
        {normal.length > 0 && danger.length > 0 ? <DropdownMenuSeparator /> : null}
        {danger.map(item)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
