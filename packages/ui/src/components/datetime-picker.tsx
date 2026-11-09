"use client"

import * as React from "react"
import { useT } from "../lib/i18n"
import { IconCalendar } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { Calendar, PeriodCalendar } from "@admin/ui/components/calendar"
import { Input } from "@admin/ui/components/input"
import { PickerField } from "@admin/ui/components/picker-field"
import { Popover, PopoverContent, PopoverTrigger } from "@admin/ui/components/popover"
import { Separator } from "@admin/ui/components/separator"
// 时间那一半的纯函数从 `time-picker` 主文件拿，不直接引 `./time-picker-state` ——
// 引别的组件的 `-state` 文件，ui:registry 会生成一个不存在的依赖条目 `time-picker-state`
import {
  joinTime,
  snapTime,
  TimeColumns,
  TimePicker,
  type TimeDisabled,
  type TimeSteps,
} from "@admin/ui/components/time-picker"
import { cn } from "@admin/ui/lib/utils"
import {
  formatPeriod,
  p2,
  parseDateStr,
  parsePeriod,
  parseTyped,
  periodRange,
  pickRangeDay,
  previewRange,
  stampValue,
  timePart,
  toDateStr,
  type Picker,
  type RangeDraft,
} from "./datetime-picker-state"

export { parseDateStr, stampValue, timePart, toDateStr, formatPeriod, parsePeriod, periodRange, type Picker }

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
 * 按月 / 按年（`picker`）时单值是 `'YYYY-MM'` / `'YYYY'`，区间仍是整段的起止日期串。
 *
 * 另外配了**快捷区间**：日志排查的起手式几乎总是「今天」或「近 7 天」，
 * 而日历要点两次才选得出来。快捷区间是一次点击，日历留给真正的自定义。
 *
 * ## 交互（对齐 Element Plus / antdv，#266）
 *
 * - **草稿**：面板里点的、敲的都先进草稿。不带时间的单值点一下就提交；带时间的
 *   要点「确定」。点外面 / Esc 丢掉草稿 —— 区间只点了一端就关掉，那一端也丢掉
 * - **区间重选**：已经选好再点，是从这一天重新开始，不是拉长原区间；等第二下时
 *   悬停预览
 * - **手输**：单值的触发器就是输入框，回车提交；区间在面板底部的两个框里敲
 */

const DAY_MS = 86_400_000

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

/** 时间列的步长 / 禁用项，原样交给 `TimeColumns` */
export type TimeOptions = TimeSteps & TimeDisabled

/** 「此刻」：对齐到步长，不然三列里没有一格是选中的 */
const nowTime = (o: TimeOptions = {}) => {
  const n = new Date()
  return joinTime(snapTime([n.getHours(), n.getMinutes(), n.getSeconds()], o))
}

/* ------------------------------------------------------------------ 单值 */

export function DateTimeValuePicker({
  value,
  onChange,
  withTime,
  picker = "date",
  timeOptions,
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
  /** 粒度。`month` / `year` 时值是 `'YYYY-MM'` / `'YYYY'`，`withTime` 不起作用 */
  picker?: Picker
  timeOptions?: TimeOptions
  placeholder?: string
  size?: keyof typeof heights
  className?: string
  disabled?: boolean
  id?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  const t = useT()
  const hasTime = Boolean(withTime) && picker === "date"
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<string | undefined>(value)
  const [text, setText] = React.useState(value ?? "")
  /** 日视图显示哪个月 —— 受控，手输一个合法日期时跳过去 */
  const [month, setMonth] = React.useState<Date | undefined>(undefined)
  const typedBad = text.trim() !== "" && parseTyped(text, { picker, withTime: hasTime }) === null

  React.useEffect(() => {
    if (!open) setText(value ?? "")
  }, [open, value])

  const changeOpen = (next: boolean) => {
    if (next && !open) {
      setDraft(value)
      setMonth(parsePeriod(value, picker))
    }
    if (!next) setText(value ?? "")
    setOpen(next)
  }
  const commit = (v: string | undefined) => {
    onChange(v)
    setText(v ?? "")
    setOpen(false)
  }
  const putDraft = (v: string) => {
    setDraft(v)
    setText(v)
  }

  const draftDate = parsePeriod(draft, picker)
  const draftTime = hasTime ? timePart(draft, false) : undefined
  const placeholderText =
    placeholder ?? (picker === "year" ? t("选择年份") : picker === "month" ? t("选择月份") : t("选择日期"))

  return (
    <PickerField
      open={open}
      onOpenChange={changeOpen}
      text={text}
      onTextChange={(s) => {
        setText(s)
        const v = parseTyped(s, { picker, withTime: hasTime })
        if (!v) return
        setDraft(v)
        const d = parsePeriod(v, picker)
        if (d) setMonth(d)
      }}
      onEnter={() => {
        if (text.trim() === "") {
          commit(undefined)
          return true
        }
        const v = parseTyped(text, { picker, withTime: hasTime })
        if (!v) return false
        commit(v)
        return true
      }}
      invalid={typedBad}
      onClear={() => commit(undefined)}
      icon={<IconCalendar />}
      placeholder={placeholderText}
      size={size}
      disabled={disabled}
      id={id}
      className={className}
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {picker === "date" ? (
        <div className="flex">
          <Calendar
            mode="single"
            required
            selected={draftDate}
            month={month}
            onMonthChange={setMonth}
            onSelect={(d) => {
              if (!hasTime) return commit(toDateStr(d))
              putDraft(stampValue(d, { withTime: true, time: draftTime }))
            }}
          />
          {hasTime && (
            // 时间列**绝对定位**撑满日历的高度：它本身有 24 / 60 / 60 行，按内容撑开会把
            // 浮层顶出视口（实测：浮层翻到了页面最上面，下半截时间列看不到）
            <div className="relative w-42 border-s">
              <div
                className="flex h-14 items-center justify-center border-b px-3 text-sm font-medium tabular-nums"
                data-testid={testId && `${testId}-draft-time`}
              >
                {draftTime}
              </div>
              <TimeColumns
                value={draft ? draftTime : undefined}
                className="absolute inset-x-0 top-14 bottom-0 h-auto"
                data-testid={testId && `${testId}-time`}
                onChange={(time) => putDraft(stampValue(draftDate ?? new Date(), { withTime: true, time }))}
                {...timeOptions}
              />
            </div>
          )}
        </div>
      ) : (
        <PeriodCalendar
          key={draftDate ? draftDate.getFullYear() : "none"}
          picker={picker}
          selected={draftDate}
          onPick={(d) => commit(formatPeriod(d, picker))}
        />
      )}

      <div className="flex items-center justify-between gap-2 border-t p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          data-testid={testId && `${testId}-now`}
          onClick={() => {
            const now = new Date()
            commit(hasTime ? `${toDateStr(now)} ${nowTime(timeOptions)}` : formatPeriod(now, picker))
          }}
        >
          {hasTime ? t("此刻") : picker === "year" ? t("今年") : picker === "month" ? t("本月") : t("今天")}
        </Button>
        {hasTime && (
          <Button
            type="button"
            size="sm"
            className="h-7 px-3"
            disabled={!draftDate}
            data-testid={testId && `${testId}-ok`}
            onClick={() => commit(draft)}
          >
            {t("确定")}
          </Button>
        )}
      </div>
    </PickerField>
  )
}

/* ------------------------------------------------------------------ 区间 */

/** 区间面板里的草稿：点选状态 + 两端各自的时间 + 底部两个输入框里敲的字 */
interface RangeState extends RangeDraft {
  startTime: string
  endTime: string
  startText: string
  endText: string
}

export function DateTimeRangePicker({
  value,
  onChange,
  withTime,
  picker = "date",
  timeOptions,
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
  /** 粒度。`month` / `year` 时点的是整月 / 整年，值仍是起止日期串（起点那段的第一天 ~ 终点那段的最后一天） */
  picker?: Picker
  timeOptions?: TimeOptions
  /** 左侧快捷区间。区间几乎总是「近 N 天」，默认开（按月 / 按年时不显示） */
  presets?: boolean
  placeholder?: string
  size?: keyof typeof heights
  className?: string
  disabled?: boolean
  id?: string
  "aria-label"?: string
  "data-testid"?: string
}) {
  const t = useT()
  const byDay = picker === "date"
  const hasTime = Boolean(withTime) && byDay
  const showPresets = presets && byDay
  const [open, setOpen] = React.useState(false)
  const [start, end] = value ?? [undefined, undefined]

  const fromValue = (): RangeState => {
    const from = parsePeriod(start, byDay ? "date" : picker)
    const to = parsePeriod(end, byDay ? "date" : picker)
    return {
      from,
      to,
      pending: false,
      startTime: timePart(start, false),
      endTime: timePart(end, true),
      startText: start ? toDateStr(parseDateStr(start) ?? new Date()) : "",
      endText: end ? toDateStr(parseDateStr(end) ?? new Date()) : "",
    }
  }
  const [s, setS] = React.useState<RangeState>(fromValue)
  const [hover, setHover] = React.useState<Date | undefined>()
  const [month, setMonth] = React.useState<Date | undefined>(undefined)

  const preset = matchRangePreset([start, end], withTime)
  /** 按月 / 按年时关闭态显示 `2026-01 ~ 2026-03`；值是脏串就原样显示，不要白屏 */
  const periodLabel = (v: string | undefined) => {
    if (!v) return t("不限")
    const d = parseDateStr(v)
    return d ? formatPeriod(d, picker) : v
  }
  const label = !byDay
    ? start || end
      ? `${periodLabel(start)} ~ ${periodLabel(end)}`
      : (placeholder ?? t("选择时间范围"))
    : preset === "all"
      ? (placeholder ?? t("选择时间范围"))
      : preset === "custom"
        ? `${shortStamp(start) || t("不限")} ~ ${shortStamp(end) || t("不限")}`
        : t(RANGE_PRESET_LABEL[preset])

  const changeOpen = (next: boolean) => {
    if (next && !open) {
      const init = fromValue()
      setS(init)
      setMonth(init.from)
      setHover(undefined)
    }
    setOpen(next)
  }
  const commit = (v: RangeValue | undefined) => {
    onChange(v)
    setOpen(false)
  }
  /** 草稿 → 值。只有两端都有了才提交得了 */
  const commitDraft = (st: RangeState) => {
    if (!st.from || !st.to || st.pending) return false
    if (!byDay) {
      commit(periodRange(st.from, st.to, picker, withTime))
      return true
    }
    commit([
      stampValue(st.from, { withTime: hasTime, time: hasTime ? st.startTime : undefined }),
      stampValue(st.to, { withTime: hasTime, endOfDay: true, time: hasTime ? st.endTime : undefined }),
    ])
    return true
  }

  /** 点了一天 / 一个月 / 一年 */
  const pick = (d: Date) => {
    const r = pickRangeDay(s, d)
    const next: RangeState = {
      ...s,
      ...r,
      startText: r.from ? toDateStr(r.from) : "",
      endText: r.to ? toDateStr(r.to) : "",
    }
    setS(next)
    setHover(undefined)
    // 不带时间：第二下点完就提交关掉（和单值点一下就提交是一个手感）
    if (!r.pending && !hasTime) commitDraft(next)
  }

  /** 底部输入框里敲日期。合法就进草稿；两端都合法时回车提交 */
  const typeEnd = (which: "start" | "end", text: string) => {
    const v = parseTyped(text)
    const d = v ? parseDateStr(v) : undefined
    setS((prev) => {
      const next = { ...prev, [which === "start" ? "startText" : "endText"]: text }
      if (!d) return next
      if (which === "start") next.from = d
      else next.to = d
      next.pending = false
      return next
    })
    // 敲的是结束日期时让它落在右边那个月：左边显示它的前一个月
    if (d) setMonth(which === "start" ? d : new Date(d.getFullYear(), d.getMonth() - 1, 1))
  }
  const typedOk = (text: string) => text.trim() === "" || parseTyped(text) !== null
  const enterTyped = () => {
    if (!typedOk(s.startText) || !typedOk(s.endText)) return
    // 两个框都清空 + 回车 = 清掉值
    if (!s.startText.trim() && !s.endText.trim()) return commit(undefined)
    const [a, b] = [s.from, s.to]
    if (a && b && a.getTime() > b.getTime()) return commitDraft({ ...s, from: b, to: a })
    commitDraft(s)
  }

  const preview = previewRange(s, hover)
  const calendarSelected = preview ?? (s.from ? { from: s.from, to: s.to } : undefined)

  return (
    <Popover open={open} onOpenChange={changeOpen}>
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
              !start && !end && "text-muted-foreground",
              className
            )}
          />
        }
      >
        <IconCalendar data-icon="inline-start" className="size-4" />
        <span className="truncate">{label}</span>
      </PopoverTrigger>
      <PopoverContent className="w-auto gap-0 p-0" align="start" data-testid={testId && `${testId}-panel`}>
        <div className="flex flex-col sm:flex-row">
          {showPresets && (
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
                    onClick={() => commit(presetRange(k, withTime))}
                  >
                    {t(RANGE_PRESET_LABEL[k])}
                  </button>
                ))}
              </div>
              <Separator orientation="vertical" className="hidden sm:block" />
            </>
          )}

          <div
            className={cn(
              "flex flex-col",
              // 悬停预览的那段用主色浅底，和选定后的灰底分开：一眼分得清「点了的」和「将要点的」。
              // ⚠️ 不能用 `bg-muted/50` —— `--muted` 亮度本来就是 0.97，再减半透明度实测完全看不出来
              preview && "[&_[data-range-middle=true]]:bg-primary/10"
            )}
            data-previewing={preview ? "true" : undefined}
            onMouseLeave={() => setHover(undefined)}
          >
            {byDay ? (
              <Calendar
                mode="range"
                selected={calendarSelected}
                month={month}
                onMonthChange={setMonth}
                numberOfMonths={2}
                onSelect={(_, trigger) => pick(trigger)}
                onDayMouseEnter={(d) => s.pending && setHover(d)}
              />
            ) : (
              <PeriodCalendar
                picker={picker}
                selected={s.from ? { from: s.from, to: s.pending ? undefined : s.to } : undefined}
                onPick={pick}
              />
            )}

            {byDay && (
              <div
                className="flex flex-wrap items-center gap-2 border-t p-2"
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement)) return
                  if (e.target.closest('[data-slot="picker-field"]')) return // 时间框自己处理回车
                  e.preventDefault()
                  enterTyped()
                }}
              >
                <RangeEndInput
                  label={t("开始日期")}
                  text={s.startText}
                  invalid={!typedOk(s.startText)}
                  onText={(x) => typeEnd("start", x)}
                  testId={testId && `${testId}-start`}
                />
                {hasTime && (
                  <TimePicker
                    size="sm"
                    className="w-30"
                    clearable={false}
                    value={s.startTime}
                    onChange={(v) => setS((p) => ({ ...p, startTime: v ?? "00:00:00" }))}
                    disabled={!s.from}
                    aria-label={t("开始时间")}
                    data-testid={testId && `${testId}-start-time`}
                    {...timeOptions}
                  />
                )}
                <span className="text-muted-foreground">~</span>
                <RangeEndInput
                  label={t("结束日期")}
                  text={s.endText}
                  invalid={!typedOk(s.endText)}
                  onText={(x) => typeEnd("end", x)}
                  testId={testId && `${testId}-end`}
                />
                {hasTime && (
                  <TimePicker
                    size="sm"
                    className="w-30"
                    clearable={false}
                    value={s.endTime}
                    onChange={(v) => setS((p) => ({ ...p, endTime: v ?? "23:59:59" }))}
                    disabled={!s.to || s.pending}
                    aria-label={t("结束时间")}
                    data-testid={testId && `${testId}-end-time`}
                    {...timeOptions}
                  />
                )}
              </div>
            )}
          </div>
        </div>

        <Separator />
        <div className="flex items-center justify-end gap-2 p-2">
          <Button
            variant="ghost" size="sm" className="h-7 px-2"
            disabled={!start && !end}
            data-testid={testId && `${testId}-clear`}
            onClick={() => commit(undefined)}
          >
            {t("清除")}
          </Button>
          {hasTime && (
            <Button
              type="button"
              size="sm"
              className="h-7 px-3"
              disabled={!s.from || !s.to || s.pending}
              data-testid={testId && `${testId}-ok`}
              onClick={() => commitDraft(s)}
            >
              {t("确定")}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function RangeEndInput({
  label,
  text,
  invalid,
  onText,
  testId,
}: {
  label: string
  text: string
  invalid: boolean
  onText: (s: string) => void
  testId?: string
}) {
  return (
    <Input
      className="h-8 w-28 tabular-nums"
      value={text}
      placeholder="YYYY-MM-DD"
      aria-label={label}
      aria-invalid={invalid || undefined}
      autoComplete="off"
      spellCheck={false}
      data-testid={testId}
      onChange={(e) => onText(e.target.value)}
    />
  )
}

/**
 * 关闭态用的**短形式**。
 *
 * 完整串是 `2026-08-16 00:00:00`，两端拼起来 39 个字符 —— 塞进筛选栏一格
 * （250~310px）必然截断，为了它把那一格加宽到跨两格又会在网格里留个洞。
 * 而这两段信息里有一半是废的：**同年就不用写年份，整天边界就不用写时分秒**
 * （「00:00:00 ~ 23:59:59」是选整天的必然结果，不是用户选的内容）。
 * 完整值在展开的面板底部写着，不会丢。
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
