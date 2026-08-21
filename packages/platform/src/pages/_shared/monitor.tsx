import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { formatNumber, formatTime } from '@admin/i18n'
import { IconRefresh } from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@admin/ui/components/select'
import { cn } from '@admin/ui/lib/utils'

import { TONE_CLASS, type Tone } from './status'

/**
 * 监控页公共件。
 *
 * 三个监控页（服务器 / Redis / 在线用户）共享一套「指标卡 + 键值卡 + 刷新控制」，
 * 和列表页的 `_shared/filters.tsx` 是同一个道理 —— 抄一次就多一处漂移源。
 *
 * ⚠️ 刻意不用 recharts 画趋势线：图表库的 ResponsiveContainer 要测容器宽度，
 * 而隐藏 tab 是 `display:none`（宽度 0，见硬纪律 5）。这里的 `<Sparkline>` 是
 * 固定 viewBox 的内联 SVG + `preserveAspectRatio="none"`，纯 CSS 缩放，
 * 完全不需要测量 —— 切 tab 回来不会画崩。
 */

// ─── 阈值配色 ────────────────────────────────────────────────────────────────

/** 使用率 → 色调。阈值只在这里定义，三个页面共用 */
export function usageTone(pct: number): Tone {
  if (Number.isNaN(pct)) return 'muted'
  if (pct >= 90) return 'danger'
  if (pct >= 75) return 'warning'
  return 'success'
}

const BAR_CLASS: Record<Tone, string> = {
  success: 'bg-emerald-500',
  danger: 'bg-destructive',
  warning: 'bg-amber-500',
  info: 'bg-sky-500',
  muted: 'bg-muted-foreground/40',
}

const TEXT_CLASS: Record<Tone, string> = {
  success: 'text-emerald-700 dark:text-emerald-300',
  danger: 'text-destructive',
  warning: 'text-amber-700 dark:text-amber-300',
  info: 'text-sky-700 dark:text-sky-300',
  muted: 'text-foreground',
}

/** 百分比进度条。Base UI 的 Progress 带 label/value 插槽，这里只要一条细轨 */
export function UsageBar({ pct, tone }: { pct: number; tone?: Tone }) {
  // ⚠️ 不要把这个变量叫 `t` —— 会遮蔽翻译函数（本仓库踩过四次）
  const tn = tone ?? usageTone(pct)
  const w = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0))
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div className={cn('h-full rounded-full transition-[width]', BAR_CLASS[tn])} style={{ width: `${w}%` }} />
    </div>
  )
}

// ─── 指标卡 ──────────────────────────────────────────────────────────────────

/**
 * 顶部大指标。`pct` 给了就带进度条，否则是纯数值卡。
 */
export function MetricCard({
  label, value, unit, hint, pct, tone, testId, children,
}: {
  label: string
  value: React.ReactNode
  unit?: string
  hint?: React.ReactNode
  pct?: number
  tone?: Tone
  testId?: string
  children?: React.ReactNode
}) {
  // ⚠️ 不要把这个变量叫 `t` —— 会遮蔽翻译函数
  const tn = tone ?? (pct === undefined ? 'muted' : usageTone(pct))
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1">
        <span
          data-testid={testId ? `${testId}-value` : undefined}
          className={cn('font-mono text-2xl font-semibold tabular-nums leading-none', TEXT_CLASS[tn])}
        >
          {value}
        </span>
        {unit && <span className="text-xs text-muted-foreground">{unit}</span>}
      </span>
      {pct !== undefined && <UsageBar pct={pct} tone={tn} />}
      {hint && <span className="text-[11px] leading-tight text-muted-foreground">{hint}</span>}
      {children}
    </div>
  )
}

// ─── 键值卡 ──────────────────────────────────────────────────────────────────

export function InfoCard({
  title, icon, action, children, className, testId,
}: {
  title: string
  icon?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  testId?: string
}) {
  return (
    <div className={cn('flex flex-col rounded-lg border border-border', className)} data-testid={testId}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        {icon}
        <h2 className="text-sm font-medium">{title}</h2>
        {action && <div className="ms-auto">{action}</div>}
      </div>
      <div className="flex flex-col px-4 py-1">{children}</div>
    </div>
  )
}

/** 卡内一行「标签 —— 值」。值默认等宽字体：监控数字要能上下对齐着扫 */
export function InfoRow({
  label, value, mono = true, tone, title,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  tone?: Tone
  title?: string
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        title={title}
        className={cn(
          'truncate text-right text-sm',
          mono && 'font-mono text-xs tabular-nums',
          tone && TEXT_CLASS[tone]
        )}
      >
        {value}
      </span>
    </div>
  )
}

// ─── 趋势线 ──────────────────────────────────────────────────────────────────

/**
 * 采样历史。`token` 变化才追加一个点 —— 直接依赖 value 会有两个问题：
 *   1. 值没变（CPU 连续两次都是 12.0%）就不记点，趋势线会失真
 *   2. `<Activity>` 切回来时 effect 重跑，会凭空补一个重复点
 * 传 query 的 `dataUpdatedAt` 当 token 最合适：每次真正取到数才动。
 */
export function useSamples(value: number | undefined, token: number | undefined, cap = 40): number[] {
  const [samples, setSamples] = React.useState<number[]>([])
  const lastToken = React.useRef<number | undefined>(undefined)

  React.useEffect(() => {
    if (value === undefined || token === undefined) return
    if (lastToken.current === token) return
    lastToken.current = token
    setSamples((prev) => [...prev, value].slice(-cap))
  }, [value, token, cap])

  return samples
}

/**
 * 内联 SVG 折线图。固定 viewBox + `preserveAspectRatio="none"`，
 * 靠 CSS 拉伸 —— 不测量容器，所以隐藏 tab 里也不会画崩（硬纪律 5）。
 */
export function Sparkline({
  points, max, tone = 'info', height = 48, testId,
}: {
  points: number[]
  /** y 轴上限；不传则取样本最大值（至少 1） */
  max?: number
  tone?: Tone
  height?: number
  testId?: string
}) {
  const { t } = useTranslation()
  const W = 100
  const H = 32
  const top = max ?? Math.max(1, ...points)
  const stroke = {
    success: 'stroke-emerald-500', danger: 'stroke-destructive', warning: 'stroke-amber-500',
    info: 'stroke-sky-500', muted: 'stroke-muted-foreground',
  }[tone]
  const fill = {
    success: 'fill-emerald-500/15', danger: 'fill-destructive/15', warning: 'fill-amber-500/15',
    info: 'fill-sky-500/15', muted: 'fill-muted',
  }[tone]

  if (points.length < 2) {
    return (
      <div
        className="flex items-center justify-center rounded-md bg-muted/40 text-[11px] text-muted-foreground"
        style={{ height }}
        data-testid={testId}
      >
        {t('采样中…（每次刷新记一个点）')}
      </div>
    )
  }

  const step = W / (points.length - 1)
  const y = (v: number) => H - (Math.min(v, top) / top) * H
  const line = points.map((v, i) => `${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height }}
      className="w-full"
      data-testid={testId}
      data-samples={points.length}
      aria-hidden
    >
      <polygon points={area} className={cn('stroke-none', fill)} />
      <polyline points={line} className={cn('fill-none', stroke)} strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ─── 横条排行（Redis 命令统计那种） ───────────────────────────────────────────

export function BarList({
  items, testId,
}: {
  items: Array<{ name: string; value: number }>
  testId?: string
}) {
  const top = Math.max(1, ...items.map((i) => i.value))
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      {items.map((i) => (
        <div key={i.name} className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3">
          <span className="truncate font-mono text-xs" title={i.name}>{i.name}</span>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-sky-500/70" style={{ width: `${(i.value / top) * 100}%` }} />
          </div>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {formatNumber(i.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── 刷新控制 ────────────────────────────────────────────────────────────────

/** 自动刷新间隔（秒）。0 = 手动 */
export const REFRESH_ITEMS: Record<string, string> = {
  '0': '手动刷新',
  '5': '每 5 秒',
  '10': '每 10 秒',
  '30': '每 30 秒',
  '60': '每 1 分钟',
}

export const DEFAULT_REFRESH = 10

/**
 * 「自动刷新间隔 + 立即刷新 + 最后更新时间」。
 *
 * 间隔本身也是视图状态，走 URL（硬纪律 2）—— 刷新页面后仍是原来的节奏。
 *
 * 注意隐藏的 tab 会被 `<Activity>` 销毁 effect，`refetchInterval` 随之停摆 ——
 * 这正是我们要的：后台挂着 5 个监控 tab 不会同时打后端。
 */
export function RefreshBar({
  interval, onIntervalChange, onRefresh, fetching, updatedAt,
}: {
  interval: number
  onIntervalChange: (v: number) => void
  onRefresh: () => void
  fetching?: boolean
  updatedAt?: number
}) {
  const { t } = useTranslation()
  const refreshLabels = React.useMemo(
    () => Object.fromEntries(Object.entries(REFRESH_ITEMS).map(([v, l]) => [v, t(l)])),
    [t]
  )
  return (
    <div className="flex items-center gap-2">
      {updatedAt ? (
        <span className="hidden text-xs text-muted-foreground @xl/main:inline" data-testid="updated-at">
          {t('最后更新 {{at}}', { at: formatTime(updatedAt) })}
        </span>
      ) : null}
      {/* REFRESH_ITEMS 是模块级常量（切语言不会重算）—— 在渲染处逐条 t()，
          和 _shared/filters.tsx 的 SelectFilter 同一套做法 */}
      <Select
        value={String(interval)}
        items={refreshLabels}
        onValueChange={(v) => onIntervalChange(Number(v ?? DEFAULT_REFRESH))}
      >
        {/* size="sm" 才是 32px —— className 里写 h-8 压不过基础类的
            `data-[size=default]:h-9`，详见 _shared/filters.tsx 的注释 */}
        <SelectTrigger size="sm" className="w-28" data-testid="refresh-interval">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(refreshLabels).map(([v, label]) => (
            <SelectItem key={v} value={v}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" className="h-8" data-testid="refresh-now" onClick={onRefresh}>
        <IconRefresh className={cn('size-4', fetching && 'animate-spin')} />
        {t('刷新')}
      </Button>
    </div>
  )
}

// ─── 取数失败 ────────────────────────────────────────────────────────────────

/**
 * 监控接口失败要说清楚是什么失败了 —— 这三个接口一半是超管专属，
 * 权限不足时后端返回 403，不提示的话页面就是一片空白。
 */
export function MonitorError({ error, testId = 'monitor-error' }: { error: unknown; testId?: string }) {
  const { t } = useTranslation()
  const e = error as { httpStatus?: number; message?: string } | null
  const forbidden = e?.httpStatus === 403
  return (
    <div
      className="flex flex-col gap-1 rounded-md bg-destructive/10 px-4 py-3 ring-1 ring-destructive/25"
      data-testid={testId}
    >
      <p className="text-sm font-medium text-destructive">
        {forbidden ? t('没有权限读取监控数据') : t('监控数据获取失败')}
      </p>
      <p className="text-xs text-destructive/80">
        {forbidden ? t('该接口仅超级管理员可用。') : (e?.message ?? t('未知错误'))}
      </p>
    </div>
  )
}

/** 首屏骨架：指标卡与卡片的占位，避免「空白 → 满屏」的跳动 */
export function MonitorSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="flex flex-col gap-4" data-testid="monitor-skeleton">
      <div className="grid grid-cols-1 gap-3 @2xl/main:grid-cols-4">
        {Array.from({ length: cards }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg border border-border bg-muted/40" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 @3xl/main:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-48 animate-pulse rounded-lg border border-border bg-muted/40" />
        ))}
      </div>
    </div>
  )
}

export { TONE_CLASS }
