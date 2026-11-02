import { IconPlus } from '@tabler/icons-react'
import type * as React from 'react'

import { RefreshButton } from './filters'

import { cn } from '@admin/ui/lib/utils'

/**
 * 卡片页（模型密钥 / MCP 凭据 / 短信配置 / 群机器人 / 存储）共用的两块（#210 P1-9）。
 *
 * 外框和标题区五页本来就是同一套写法，没收；真正各写各的是这两处：
 * - **键值区**：标签列宽写死成 `w-10` / `w-14` / `w-16` 三种，同一行的「标签 + 值」两列在卡片之间对不齐，
 *   而且宽度一写死，换成英文标签（`Last success`）就把值挤到下一行。现在是 grid 的 `max-content` 列：
 *   标签列按**这张卡里最长的标签**自适应，不用再猜宽度。标签另有 `max-w-24` 上限、超了就折行 ——
 *   否则英文的 `Business template` 会把整列撑到 110px，值列（多是 `truncate` 的凭据 / 地址）被截得更狠（#215 评审）
 * - **「新增」格**：五份手抄，最小高度 `min-h-44` / `48` / `52` 三种
 */

/**
 * 卡片外框。🔴 `bg-card` 不能省：浅色下 `--card` 和 `--background` 同为白色看不出差别，
 * 深色下只画一圈边框的卡片和页面融成一片（#210）。原来这串类名在六个页面里各手抄一遍，
 * 下一个照抄旧字符串的页面会把 `bg-card` 丢掉（#217 评审）—— 所以收在这里。
 */
export function ResourceCard({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 rounded-lg border bg-card p-4', className)} {...props} />
}

/** 卡片里的键值区。子元素只放 `CardField` */
export function CardFields({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs', className)}>
      {children}
    </dl>
  )
}

/**
 * 一行键值。`className` 加在值上（`font-mono` / `truncate` 这类）。
 * 渲染成 `<dt>` + `<dd>` 两个兄弟元素 —— 父级 grid 要直接拿到它们，所以外面不能再包一层。
 */
export function CardField({
  label,
  children,
  className,
  title,
  testId,
}: {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
  title?: string
  testId?: string
}) {
  return (
    <>
      <dt className="max-w-24 text-muted-foreground">{label}</dt>
      {/* 值是纯文本时自动带 title：卡片里的地址 / 凭据多是 truncate 的，截了得有办法看全 */}
      <dd
        className={cn('min-w-0 break-words', className)}
        title={title ?? (typeof children === 'string' ? children : undefined)}
        data-testid={testId}
      >
        {children}
      </dd>
    </>
  )
}

/**
 * 网格最后一格的「新增」。
 *
 * 🔴 「新增」放在网格里而不是右上角：这类配置常年只有一两条，网格必然缺角，右上角的按钮
 * 恰好悬在缺角上方、离卡片半屏远（实测差 518px）；一条都没有时这一格自己就是空状态 ——
 * 空屏该是邀请动作的地方，不是一句「还没有配置」。`hint` 只在列表为空（或该提醒时）给。
 */
export function AddCard({
  label,
  hint,
  icon: Icon = IconPlus,
  onClick,
  testId,
}: {
  label: string
  hint?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  onClick: () => void
  testId?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex min-h-44 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-input p-4 text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/40 hover:text-foreground"
    >
      <Icon className="size-5" />
      <span className="text-sm">{label}</span>
      {hint ? <span className="max-w-60 text-xs text-balance">{hint}</span> : null}
    </button>
  )
}

/**
 * 卡片页右上角的刷新（#210）。web 端关了 `refetchOnWindowFocus`，不给按钮的话别人改了配置只能整页刷新。
 *
 * 🔴 **这一页用到的查询全部传进来**，不只是主列表。短信配置的卡片和表单还靠厂商 / 模板目录、群机器人靠选项：
 * 只重取主列表的话，按钮转完一圈像是整页都新了，其实「厂商不可用」的判断和模板名还是旧的，
 * 那几份之前取失败留下的错误块也不会重试（#219 评审）。
 */
export function CardPageRefresh({
  queries,
  testId,
}: {
  queries: { isFetching: boolean; refetch: () => unknown }[]
  testId: string
}) {
  return (
    <RefreshButton
      testId={testId}
      busy={queries.some((q) => q.isFetching)}
      onClick={() => queries.forEach((q) => void q.refetch())}
    />
  )
}
