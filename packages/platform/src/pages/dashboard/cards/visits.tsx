import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { formatNumber } from '@admin/i18n'

import { visitsQuery, type VisitPoint } from '../api'
import { DashboardCard } from '../card-shell'

/**
 * 画布：固定 viewBox，纯 CSS 缩放 —— 不测容器宽度（隐藏 tab 是 `display:none`，宽度 0；同监控页的 `Sparkline`）。
 * 宽度按「整行卡片在 1440 宽的屏上」取（内容约 1100px）：设计稿那张 710 宽的画布放大 1.5 倍，坐标轴的字会到 17px
 */
const W = 940
const H = 230
const LEFT = 44
const RIGHT = 934
const TOP = 16
const BASE = 200
const BAR = 18
const GAP = 3
const MAX_TICKS = 5

/**
 * 纵轴：步长取 1 / 2 / 5 × 10ⁿ（至少 1）、最多 5 格，上限取刚好盖住最大值的那一格。
 * 原来固定画满 5 格，最高 54 时步长 20 × 5 = 100，上面空了将近一半；现在画到 60
 */
function niceAxis(max: number): { top: number; ticks: number } {
  if (max <= 0) return { top: MAX_TICKS, ticks: MAX_TICKS }
  const raw = max / MAX_TICKS
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = Math.max([1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag, 1)
  const ticks = Math.ceil(max / step)
  return { top: ticks * step, ticks }
}

/** 「10-18」—— `date` 是后端按显示时区切好的 `YYYY-MM-DD`，直接取月日，不再过一次时区 */
const monthDay = (date: string) => date.slice(5)

/**
 * 「近 14 天访问」（#202，系统运行区）：每天登录成功 / 失败两根柱子，右上角今天的两个数。
 *
 * 🔴 **不用 recharts**：`ResponsiveContainer` 要测容器宽度，而隐藏 tab 是 `display:none`（宽度 0），
 * 切回来是一张空图（监控页踩过，见 pages 分册「监控页」）。这里是固定 viewBox 的内联 SVG。
 *
 * 「哪一天」后端按查看人的**显示时区**切（`visitsQuery` 带 `tz`），这里不再拿 `Date` 算日期。
 * 「今日登录」是成功次数（和蓝柱子同一个口径），失败单列。
 */
export function VisitsCard() {
  const { t } = useTranslation()
  const query = useQuery(visitsQuery())
  const points = query.data?.points ?? []
  const today = points.at(-1)

  return (
    <DashboardCard
      variant="tile"
      testId="dash-visits"
      title={t('近 14 天访问')}
      subtitle={t('每天登录成功与失败次数')}
      action={
        today ? (
          <span className="flex flex-wrap items-end gap-x-[22px] gap-y-2">
            <Stat label={t('今日登录')} value={today.total - today.fails} testId="dash-visits-today" />
            <Stat label={t('今日失败')} value={today.fails} warn testId="dash-visits-today-fails" />
            <span className="flex items-center gap-3.5 pb-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <i className="size-2.5 rounded-[2px] bg-primary" />
                {t('成功')}
              </span>
              <span className="flex items-center gap-1.5">
                <i className="size-2.5 rounded-[2px] bg-amber-500" />
                {t('失败')}
              </span>
            </span>
          </span>
        ) : undefined
      }
      loading={query.isPending}
      error={query.error}
      onRetry={() => void query.refetch()}
      hasData={Boolean(query.data)}
    >
      {points.length > 0 && <Bars points={points} />}
    </DashboardCard>
  )
}

function Stat({ label, value, warn = false, testId }: { label: string; value: number; warn?: boolean; testId: string }) {
  return (
    <span className="flex flex-col items-end">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={warn && value > 0 ? 'text-xl font-extrabold text-amber-700 tabular-nums dark:text-amber-400' : 'text-xl font-extrabold tabular-nums'}
        data-testid={testId}
      >
        {formatNumber(value)}
      </span>
    </span>
  )
}

function Bars({ points }: { points: VisitPoint[] }) {
  const { t } = useTranslation()
  const { top: max, ticks } = niceAxis(Math.max(...points.map((p) => Math.max(p.total - p.fails, p.fails))))
  const slot = (RIGHT - LEFT) / points.length
  const h = (v: number) => (v <= 0 ? 0 : Math.max(1.5, (v / max) * (BASE - TOP)))
  const last = points.length - 1

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={t('近 14 天登录柱状图')}
      data-testid="dash-visits-chart"
    >
      <g className="stroke-border" strokeWidth="1">
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const yy = TOP + ((BASE - TOP) / ticks) * i
          return <line key={i} x1={LEFT} x2={RIGHT} y1={yy} y2={yy} strokeOpacity={i === ticks ? 1 : 0.6} />
        })}
      </g>
      <g className="fill-muted-foreground" fontSize="11" textAnchor="end">
        {Array.from({ length: ticks + 1 }).map((_, i) => (
          <text key={i} x={LEFT - 8} y={TOP + ((BASE - TOP) / ticks) * i + 4}>
            {formatNumber(max - (max / ticks) * i)}
          </text>
        ))}
      </g>
      {points.map((p, i) => {
        const ok = p.total - p.fails
        const x = LEFT + slot * i + (slot - (BAR * 2 + GAP)) / 2
        return (
          <g key={p.date} data-testid="dash-visits-day" data-date={p.date} data-ok={ok} data-fails={p.fails}>
            <title>{t('{{date}} 成功 {{ok}} 次 · 失败 {{fails}} 次', { date: p.date, ok, fails: p.fails })}</title>
            {ok > 0 && <rect className="fill-primary" x={x} y={BASE - h(ok)} width={BAR} height={h(ok)} rx={3} />}
            {p.fails > 0 && <rect className="fill-amber-500" x={x + BAR + GAP} y={BASE - h(p.fails)} width={BAR} height={h(p.fails)} rx={1.5} />}
          </g>
        )
      })}
      <g className="fill-muted-foreground" fontSize="11" textAnchor="middle">
        {points.map((p, i) =>
          // 隔一天标一次，今天一定标（字太挤会叠在一起）
          i === last || (last - i) % 2 === 0 ? (
            <text
              key={p.date}
              x={LEFT + slot * i + slot / 2}
              y={H - 6}
              className={i === last ? 'fill-foreground font-semibold' : undefined}
            >
              {i === last ? t('今天') : monthDay(p.date)}
            </text>
          ) : null
        )}
      </g>
    </svg>
  )
}
