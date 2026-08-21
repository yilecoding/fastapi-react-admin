import { SelectFilter } from './filters'

/**
 * 时间范围快捷区间。
 *
 * 日志排查的起手式几乎总是「今天」或「近 7 天」，而日历要点两次（起、止）
 * 才能选出来。这里把它压成一次下拉，日历留给真正的自定义区间。
 *
 * 值的格式与 `DateRangePicker` 写进 URL 的完全一致（`YYYY-MM-DD HH:mm:ss`），
 * 所以手动选出的「今天→今天」也会被认成 `today` —— 下拉显示的是真实状态，不是上一次点了什么。
 */
export type TimeRange = { start?: string; end?: string }

export type RangePreset = 'today' | 'd7' | 'd30'

const DAY_MS = 86_400_000

function stamp(d: Date, endOfDay: boolean): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${endOfDay ? '23:59:59' : '00:00:00'}`
}

export function presetRange(key: RangePreset): TimeRange {
  const now = new Date()
  const backDays = key === 'today' ? 0 : key === 'd7' ? 6 : 29
  return {
    start: stamp(new Date(now.getTime() - backDays * DAY_MS), false),
    end: stamp(now, true),
  }
}

/** 当前区间落在哪个预设上 —— 落不上就是 custom */
export function matchPreset(r: TimeRange): 'all' | RangePreset | 'custom' {
  if (!r.start && !r.end) return 'all'
  for (const key of ['today', 'd7', 'd30'] as const) {
    const p = presetRange(key)
    if (p.start === r.start && p.end === r.end) return key
  }
  return 'custom'
}

const BASE_ITEMS: Record<string, string> = {
  all: '全部时间',
  today: '今天',
  d7: '近 7 天',
  d30: '近 30 天',
}

export function DateQuickPick({
  value,
  onChange,
  testId = 'filter-range',
}: {
  value: TimeRange
  /** 传 `{}` 表示清空时间筛选 */
  onChange: (r: TimeRange) => void
  testId?: string
}) {
  const current = matchPreset(value)
  // 「自定义」只在当前确实是自定义区间时出现在选项里 —— 它是状态显示，不是可选动作
  const items = current === 'custom' ? { ...BASE_ITEMS, custom: '自定义' } : BASE_ITEMS

  return (
    <SelectFilter
      value={current}
      items={items}
      testId={testId}
      width="min-w-28"
      onChange={(v) => {
        if (v === undefined || v === 'all') return onChange({})
        if (v === 'custom') return
        onChange(presetRange(v as RangePreset))
      }}
    />
  )
}
