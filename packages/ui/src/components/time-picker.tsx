"use client"

import * as React from "react"
import { IconClock } from "@tabler/icons-react"

import { Button } from "@admin/ui/components/button"
import { PickerField } from "@admin/ui/components/picker-field"
import { useT } from "@admin/ui/lib/i18n"
import { cn } from "@admin/ui/lib/utils"
import {
  isTimeDisabled,
  joinTime,
  parseTimeTyped,
  setUnit,
  snapTime,
  splitTime,
  unitOptions,
  type TimeDisabled,
  type TimeSteps,
  type TimeTuple,
  type TimeUnit,
} from "./time-picker-state"

export { joinTime, parseTimeTyped, snapTime, splitTime, type TimeDisabled, type TimeSteps } from "./time-picker-state"

/**
 * 时间选择：时 / 分 / 秒三列滚动（对齐 Element Plus / antdv 的时间面板，#266）。
 *
 * 换掉原生 `<input type="time">` 的理由：它的样式、12/24 小时制跟浏览器和系统走，
 * 同一个页面在两台电脑上长两个样子，而且没法配步长、没法禁用部分时刻。
 *
 * 值是 `'HH:mm:ss'` 串，24 小时制，和 `datetime-picker` 的时间部分同一个形状。
 */

const ROW = 28 // h-7，滚动对齐按这个算

export type TimeColumnsProps = TimeSteps &
  TimeDisabled & {
    value: string | undefined
    onChange: (v: string) => void
    /** 不显示秒那一列（值里秒恒为 0） */
    hideSeconds?: boolean
    className?: string
    "data-testid"?: string
  }

/** 只有三列、没有输入框和按钮 —— 给日期时间面板嵌进去用；单独用请拿 `TimePicker` */
export function TimeColumns({
  value,
  onChange,
  hideSeconds,
  hourStep,
  minuteStep,
  secondStep,
  disabledHours,
  disabledMinutes,
  disabledSeconds,
  className,
  "data-testid": testId,
}: TimeColumnsProps) {
  const t = useT()
  const tuple = splitTime(value)
  const base: TimeTuple = tuple ?? [0, 0, 0]
  const disabledHourList = disabledHours?.() ?? []
  const disabledMinuteList = disabledMinutes?.(base[0]) ?? []
  const disabledSecondList = disabledSeconds?.(base[0], base[1]) ?? []

  const cols: { unit: TimeUnit; label: string; options: number[]; disabled: readonly number[] }[] = [
    { unit: "hour", label: t("小时"), options: unitOptions(24, hourStep), disabled: disabledHourList },
    { unit: "minute", label: t("分钟"), options: unitOptions(60, minuteStep), disabled: disabledMinuteList },
    ...(hideSeconds
      ? []
      : [{ unit: "second" as const, label: t("秒"), options: unitOptions(60, secondStep), disabled: disabledSecondList }]),
  ]

  return (
    <div
      role="group"
      aria-label={t("选择时间")}
      data-slot="time-columns"
      data-testid={testId}
      className={cn("flex h-56 divide-x", className)}
    >
      {cols.map((c, i) => (
        <TimeColumn
          key={c.unit}
          unit={c.unit}
          label={c.label}
          options={c.options}
          disabled={c.disabled}
          selected={tuple ? tuple[i]! : undefined}
          onPick={(v) => onChange(joinTime(setUnit(base, c.unit, v)))}
        />
      ))}
    </div>
  )
}

function TimeColumn({
  unit,
  label,
  options,
  disabled,
  selected,
  onPick,
}: {
  unit: TimeUnit
  label: string
  options: number[]
  disabled: readonly number[]
  selected: number | undefined
  onPick: (v: number) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  const mounted = React.useRef(false)

  // 选中项滚到列顶。第一次（刚打开面板）瞬间到位，之后平滑滚 —— 刚打开就看到一段滚动很晕
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const idx = selected === undefined ? -1 : options.indexOf(selected)
    if (idx >= 0) el.scrollTo({ top: idx * ROW, behavior: mounted.current ? "smooth" : "instant" })
    mounted.current = true
  }, [selected, options])

  const move = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) {
      const v = options[i]!
      if (!disabled.includes(v)) return v
    }
    return undefined
  }

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={label}
      data-unit={unit}
      className="relative w-14 overflow-y-auto overscroll-contain py-1 [scrollbar-width:thin] after:block after:h-[calc(100%-1.75rem)]"
      onKeyDown={(e) => {
        const idx = selected === undefined ? -1 : options.indexOf(selected)
        const next =
          e.key === "ArrowDown" ? move(idx, 1)
          : e.key === "ArrowUp" ? move(idx < 0 ? options.length : idx, -1)
          : e.key === "Home" ? move(-1, 1)
          : e.key === "End" ? move(options.length, -1)
          : undefined
        if (next === undefined) return
        e.preventDefault()
        onPick(next)
        requestAnimationFrame(() =>
          ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus()
        )
      }}
    >
      {options.map((v, i) => {
        const isSel = v === selected
        const isOff = disabled.includes(v)
        // 漫游 tabindex：一列只有一格能 Tab 进来（选中的那格，没选就第一格）
        const tabbable = selected === undefined ? i === 0 : isSel
        return (
          <button
            key={v}
            type="button"
            role="option"
            aria-selected={isSel}
            aria-disabled={isOff || undefined}
            data-value={v}
            tabIndex={tabbable ? 0 : -1}
            disabled={isOff && !isSel}
            className={cn(
              "mx-1 flex h-7 w-[calc(100%-0.5rem)] items-center justify-center rounded-sm text-sm tabular-nums outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50",
              isSel && "bg-primary/10 font-medium text-primary hover:bg-primary/15",
              isOff && "text-muted-foreground line-through opacity-50 hover:bg-transparent"
            )}
            onClick={() => !isOff && onPick(v)}
          >
            {String(v).padStart(2, "0")}
          </button>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ 带输入框的 */

export type TimePickerProps = TimeSteps &
  TimeDisabled & {
    value: string | undefined
    onChange: (v: string | undefined) => void
    hideSeconds?: boolean
    placeholder?: string
    size?: "sm" | "default"
    className?: string
    disabled?: boolean
    /** 有值时显示「×」，默认开 */
    clearable?: boolean
    id?: string
    "aria-label"?: string
    "data-testid"?: string
  }

/**
 * 单独的时间选择：可以直接敲（`1405` / `14:05`），回车提交；也可以展开三列点选，
 * 点「确定」才提交 —— 点外面 / Esc 丢掉草稿（对齐 Element Plus / antdv）。
 */
export function TimePicker({
  value,
  onChange,
  hideSeconds,
  placeholder,
  size = "default",
  className,
  disabled,
  clearable = true,
  id,
  "aria-label": ariaLabel,
  "data-testid": testId,
  ...rules
}: TimePickerProps) {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState<string | undefined>(value)
  const [text, setText] = React.useState(display(value, hideSeconds))
  const typedBad = text.trim() !== "" && parseTimeTyped(text) === null

  // 关着的时候外面改了值（重置表单之类），文本跟上
  React.useEffect(() => {
    if (!open) setText(display(value, hideSeconds))
  }, [open, value, hideSeconds])

  /** 每次打开从当前值起草稿；关上时把文本恢复成当前值（敲错的不留下） */
  const changeOpen = (next: boolean) => {
    if (next && !open) setDraft(value)
    if (!next) setText(display(value, hideSeconds))
    setOpen(next)
  }

  const pickDraft = (v: string) => {
    setDraft(v)
    setText(display(v, hideSeconds))
  }
  const commit = (v: string | undefined) => {
    onChange(v)
    setText(display(v, hideSeconds))
    setOpen(false)
  }
  const draftTuple = splitTime(draft)
  const draftOff = draftTuple ? isTimeDisabled(draftTuple, rules) : false

  return (
    <PickerField
      open={open}
      onOpenChange={changeOpen}
      text={text}
      onTextChange={(s) => {
        setText(s)
        const v = parseTimeTyped(s)
        if (v) setDraft(v)
      }}
      onEnter={() => {
        if (text.trim() === "") {
          commit(undefined)
          return true
        }
        const v = parseTimeTyped(text)
        if (!v || isTimeDisabled(splitTime(v)!, rules)) return false
        commit(v)
        return true
      }}
      invalid={typedBad}
      onClear={clearable ? () => commit(undefined) : undefined}
      icon={<IconClock />}
      placeholder={placeholder ?? (hideSeconds ? "HH:mm" : "HH:mm:ss")}
      size={size}
      disabled={disabled}
      id={id}
      className={className}
      aria-label={ariaLabel ?? t("选择时间")}
      data-testid={testId}
    >
      <TimeColumns
        value={draft}
        onChange={pickDraft}
        hideSeconds={hideSeconds}
        data-testid={testId && `${testId}-columns`}
        {...rules}
      />
      <div className="flex items-center justify-between gap-2 border-t p-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          data-testid={testId && `${testId}-now`}
          onClick={() => {
            const n = new Date()
            const v = joinTime(snapTime([n.getHours(), n.getMinutes(), hideSeconds ? 0 : n.getSeconds()], rules))
            if (!isTimeDisabled(splitTime(v)!, rules)) commit(v)
          }}
        >
          {t("此刻")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="h-7 px-3"
          disabled={!draftTuple || draftOff}
          data-testid={testId && `${testId}-ok`}
          onClick={() => commit(draft)}
        >
          {t("确定")}
        </Button>
      </div>
    </PickerField>
  )
}

function display(v: string | undefined, hideSeconds?: boolean): string {
  if (!v) return ""
  return hideSeconds ? v.slice(0, 5) : v
}
