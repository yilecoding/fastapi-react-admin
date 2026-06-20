"use client"

import * as React from "react"
import { useTranslation } from "react-i18next"
import { IconCalendar, IconClock } from "@tabler/icons-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@admin/ui/components/button"
import { Calendar } from "@admin/ui/components/calendar"
import { Input } from "@admin/ui/components/input"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

/**
 * 时间筛选控件（单值 + 区间），**值是字符串不是 Date**。
 *
 * 为什么不直接用 `date-picker` / `date-range-picker`：那两个的值是 `Date` /
 * `DateRange`，而筛选值要走三条它过不去的路 ——
 *
 * 1. **URL**（硬纪律 2：视图状态必须进 URL）。`Date` 进 search params 只能变成
 *    ISO 串，回来是字符串，schema 一验就炸；
 * 2. **localStorage**（筛选视图）。`JSON.stringify(new Date())` 出去是字符串、
 *    回来还是字符串 —— 存进去能用、读回来裂，是最难查的那一类；
 * 3. **接口**。后端收的是 `start_time=2026-08-22 00:00:00` 这种本地时间串，
 *    而 `toISOString()` 是 UTC，差 8 小时且没人会往时区上想。
 *
 * 所以这里的对外形态一律是 `'YYYY-MM-DD'`（`withTime` 时
 * `'YYYY-MM-DD HH:mm:ss'`）**本地时间**串，进出都不经过 Date。
 *
 * 另外配了**快捷区间**：日志排查的起手式几乎总是「今天」或「近 7 天」，
 * 而日历要点两次才选得出来。快捷区间是一次点击，日历留给真正的自定义。
 */

const DAY_MS = 86_400_000

const p2 = (n: number) => String(n).padStart(2, "0")

/** `Date` → `'YYYY-MM-DD'`（本地时区，不是 UTC） */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** `'YYYY-MM-DD[ HH:mm:ss]'` → `Date`；解析不出来给 undefined（不要抛，脏 URL 不该白屏） */
export function parseDateStr(s: string | undefined | null): Date | undefined {
  if (!s) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s)
  if (!m) return undefined
  const d = new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)
  )
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** 取出串里的时间部分，没有就按「一天的头 / 尾」给默认值 */
export function timePart(s: string | undefined, endOfDay: boolean): string {
  const m = /[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(s ?? "")
  if (!m) return endOfDay ? "23:59:59" : "00:00:00"
  return m[1]!.length === 5 ? `${m[1]}:00` : m[1]!
}

/** 拼一个值串。`withTime=false` 时时间部分直接不要 —— 别下发用不上的精度 */
export function stampValue(d: Date, opts: { withTime?: boolean; endOfDay?: boolean; time?: string } = {}): string {
  const day = toDateStr(d)
  if (!opts.withTime) return day
  return `${day} ${opts.time ?? (opts.endOfDay ? "23:59:59" : "00:00:00")}`
}

export type RangeValue = readonly [string | undefined, string | undefined]

export type RangePresetKey =
  | "today" | "yesterday" | "d7" | "d30" | "thisMonth" | "lastMonth"

/** 预设的中文名同时是 i18n 的 key（原文即 key），所以这里存的是可直接 `t()` 的串 */
export const RANGE_PRESET_LABEL: Record<RangePresetKey, string> = {
  today: "今天",
  yesterday: "昨天",
  d7: "近 7 天",
  d30: "近 30 天",
  thisMonth: "本月",
  lastMonth: "上月",
}

export const RANGE_PRESET_KEYS = Object.keys(RANGE_PRESET_LABEL) as RangePresetKey[]

/** 预设 → 具体区间。**一律是整天边界**，「近 7 天」含今天共 7 天 */
export function presetRange(key: RangePresetKey, withTime = false): RangeValue {
  const now = new Date()
  const startOf = (d: Date) => stampValue(d, { withTime, endOfDay: false })
  const endOf = (d: Date) => stampValue(d, { withTime, endOfDay: true })

  switch (key) {
    case "today":
      return [startOf(now), endOf(now)]
    case "yesterday": {
      const y = new Date(now.getTime() - DAY_MS)
      return [startOf(y), endOf(y)]
    }
    case "d7":
      return [startOf(new Date(now.getTime() - 6 * DAY_MS)), endOf(now)]
    case "d30":
      return [startOf(new Date(now.getTime() - 29 * DAY_MS)), endOf(now)]
    case "thisMonth":
      return [startOf(new Date(now.getFullYear(), now.getMonth(), 1)), endOf(now)]
    case "lastMonth": {
      const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const last = new Date(now.getFullYear(), now.getMonth(), 0)
      return [startOf(first), endOf(last)]
    }
  }
}

/**
 * 当前区间落在哪个预设上 —— 落不上就是 `custom`。
 *
 * 这一条是「下拉回显真实状态」的前提：手动选出的「今天 → 今天」也该显示
 * 「今天」，而不是显示上一次点了哪个预设。
 */
export function matchRangePreset(v: RangeValue, withTime = false): RangePresetKey | "all" | "custom" {
  if (!v[0] && !v[1]) return "all"
  for (const k of RANGE_PRESET_KEYS) {
    const p = presetRange(k, withTime)
    if (p[0] === v[0] && p[1] === v[1]) return k
  }
  return "custom"
}

const heights = { sm: "h-8", default: "h-9" } as const

/* ------------------------------------------------------------------ 单值 */

export function DateTimeValuePicker({
  value,
  onChange,
  withTime,
  placeholder,
  size = "default",
  className,
  disabled,
  id,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: string | undefined
  onChange: (v: string | undefined) => void
  withTime?: boolean
  placeholder?: string
  size?: keyof typeof heights
  className?: string
  disabled?: boolean
  id?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const date = parseDateStr(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            id={id}
            disabled={disabled}
            aria-label={ariaLabel}
            data-testid={testId}
            className={cn(
              "w-full justify-start px-2.5 font-normal",
              heights[size],
              !value && "text-muted-foreground",
              className
            )}
          />
        }
      >
        <IconCalendar data-icon="inline-start" className="size-4" />
        <span className="truncate">{value ?? placeholder ?? t("选择日期")}</span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          captionLayout="dropdown"
          onSelect={(d) => {
            if (!d) return onChange(undefined)
            onChange(stampValue(d, { withTime, time: withTime ? timePart(value, false) : undefined }))
            if (!withTime) setOpen(false)
          }}
        />
        {withTime && (
          <>
            <Separator />
            <div className="flex items-center gap-2 p-2">
              <IconClock className="size-4 shrink-0 text-muted-foreground" />
              <Input
                type="time"
                step={1}
                className="h-8"
                value={timePart(value, false)}
                data-testid={testId && `${testId}-time`}
                disabled={!date}
                onChange={(e) => {
                  if (!date) return
                  onChange(stampValue(date, { withTime: true, time: normTime(e.target.value) }))
                }}
              />
            </div>
          </>
        )}
        {value && (
          <>
            <Separator />
            <div className="flex justify-end p-2">
              <Button variant="ghost" size="sm" onClick={() => { onChange(undefined); setOpen(false) }}>
                {t("清除")}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------------------------------------------ 区间 */

export function DateTimeRangePicker({
  value,
  onChange,
  withTime,
  presets = true,
  placeholder,
  size = "default",
  className,
  disabled,
  id,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  value: RangeValue | undefined
  onChange: (v: RangeValue | undefined) => void
  withTime?: boolean
  /** 左侧快捷区间。区间几乎总是「近 N 天」，默认开 */
  presets?: boolean
  placeholder?: string
  size?: keyof typeof heights
  className?: string
  disabled?: boolean
  id?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [start, end] = value ?? [undefined, undefined]
  const range: DateRange | undefined = React.useMemo(() => {
    const from = parseDateStr(start)
    const to = parseDateStr(end)
    return from || to ? { from, to } : undefined
  }, [start, end])

  const preset = matchRangePreset([start, end], withTime)
  const label =
    preset === "all"
      ? (placeholder ?? t("选择时间范围"))
      : preset === "custom"
        ? `${shortStamp(start) || t("不限")} ~ ${shortStamp(end) || t("不限")}`
        : t(RANGE_PRESET_LABEL[preset])

  /** 日历只给「哪天」，时间部分沿用当前值（没有就取整天边界） */
  const commitDays = (r: DateRange | undefined) => {
    if (!r?.from && !r?.to) return onChange(undefined)
    onChange([
      r.from ? stampValue(r.from, { withTime, time: withTime ? timePart(start, false) : undefined }) : undefined,
      r.to ? stampValue(r.to, { withTime, endOfDay: true, time: withTime ? timePart(end, true) : undefined }) : undefined,
    ])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            id={id}
            disabled={disabled}
            aria-label={ariaLabel}
            data-testid={testId}
            className={cn(
              "w-full justify-start px-2.5 font-normal",
              heights[size],
              preset === "all" && "text-muted-foreground",
              className
            )}
          />
        }
      >
        <IconCalendar data-icon="inline-start" className="size-4" />
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col sm:flex-row">
          {presets && (
            <>
              {/* 快捷区间在**左侧竖列**而不是顶部一排：一排放不下 6 项，
                  换行之后和日历的两个月对不齐，看着像两个控件粘在一起 */}
              <div className="flex flex-row gap-1 overflow-x-auto p-2 sm:w-28 sm:flex-col sm:overflow-visible">
                {RANGE_PRESET_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    data-testid={testId && `${testId}-preset-${k}`}
                    className={cn(
                      "shrink-0 rounded-sm px-2 py-1.5 text-start text-sm whitespace-nowrap hover:bg-muted",
                      preset === k && "bg-primary/10 font-medium text-primary"
                    )}
                    onClick={() => { onChange(presetRange(k, withTime)); setOpen(false) }}
                  >
                    {t(RANGE_PRESET_LABEL[k])}
                  </button>
                ))}
              </div>
              <Separator orientation="vertical" className="hidden sm:block" />
            </>
          )}

          <div className="flex flex-col">
            <Calendar
              mode="range"
              selected={range}
              defaultMonth={range?.from}
              numberOfMonths={2}
              onSelect={commitDays}
            />
            {withTime && (
              <>
                <Separator />
                <div className="flex items-center gap-2 p-2">
                  <IconClock className="size-4 shrink-0 text-muted-foreground" />
                  <Input
                    type="time" step={1} className="h-8" aria-label={t("开始时间")}
                    value={timePart(start, false)} disabled={!range?.from}
                    data-testid={testId && `${testId}-start-time`}
                    onChange={(e) => {
                      if (!range?.from) return
                      onChange([stampValue(range.from, { withTime: true, time: normTime(e.target.value) }), end])
                    }}
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="time" step={1} className="h-8" aria-label={t("结束时间")}
                    value={timePart(end, true)} disabled={!range?.to}
                    data-testid={testId && `${testId}-end-time`}
                    onChange={(e) => {
                      if (!range?.to) return
                      onChange([start, stampValue(range.to, { withTime: true, time: normTime(e.target.value) })])
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {preset !== "all" && (
          <>
            <Separator />
            <div className="flex items-center justify-between gap-2 p-2">
              <span className="truncate ps-1 text-xs text-muted-foreground">
                {start ?? t("不限")} ~ {end ?? t("不限")}
              </span>
              <Button
                variant="ghost" size="sm" className="shrink-0"
                data-testid={testId && `${testId}-clear`}
                onClick={() => { onChange(undefined); setOpen(false) }}
              >
                {t("清除")}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * 关闭态用的**短形式**。
 *
 * 完整串是 `2026-08-16 00:00:00`，两端拼起来 39 个字符 —— 塞进筛选栏一格
 * （250~310px）必然截断，为了它把那一格加宽到跨两格又会在网格里留个洞。
 * 而这两段信息里有一半是废的：**同年就不用写年份，整天边界就不用写时分秒**
 * （「00:00:00 ~ 23:59:59」是选整天的必然结果，不是用户选的内容）。
 * 完整值在展开的日历底部写着，不会丢。
 */
function shortStamp(v: string | undefined): string {
  if (!v) return ""
  const d = parseDateStr(v)
  if (!d) return v
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const day = sameYear ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())}` : toDateStr(d)
  const time = timePart(v, false)
  // 整天边界（含 `withTime=false` 时根本没有时间段）不显示时间
  const whole = !/[ T]/.test(v) || time === "00:00:00" || time === "23:59:59"
  return whole ? day : `${day} ${time.slice(0, 5)}`
}

/** `<input type="time">` 在 step≥60 的浏览器下只给 `HH:mm` —— 补齐秒 */
function normTime(v: string): string {
  if (!v) return "00:00:00"
  return v.length === 5 ? `${v}:00` : v
}
