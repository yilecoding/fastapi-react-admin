import * as React from "react"
import {
  DayPicker,
  getDefaultClassNames,
  type DayButton,
  type Locale,
  type MonthCaptionProps,
} from "react-day-picker"
import { enUS, zhCN } from "react-day-picker/locale"

import { cn } from "@admin/ui/lib/utils"
import { useLang, useT } from "@admin/ui/lib/i18n"
import { Button, buttonVariants } from "@admin/ui/components/button"
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronsLeft,
  IconChevronsRight,
} from "@tabler/icons-react"
import {
  addMonths,
  canShift,
  clampFirstMonth,
  decadeStart,
  firstMonthForPanel,
  initialMonth,
  monthCells,
  monthSerial,
  pickLocaleKey,
  startOfMonth,
  yearCells,
  yearFirst,
  type MonthBounds,
} from "./calendar-state"

/**
 * 日历。react-day-picker 管「日」那一层（键盘、a11y、区间逻辑），
 * 表头和年 / 月面板是这里自己补的 —— 交互对齐 Element Plus / antdv（#266）：
 *
 * ```
 * «  ‹   2026年  11月   ›  »        « 跳一年  ‹ 跳一月
 *         │       └──▶ 月面板（3×4）── 点某月 ──▶ 回到日
 *         └──▶ 年面板（12 格）── 点某年 ──▶ 月面板
 * ```
 *
 * 🔴 **没有 `captionLayout="dropdown"`，而且故意不留。** react-day-picker 的年份
 * 下拉在调用方不传 `endMonth` 时会把导航范围**静默**锁到「今年 12 月」
 * （`getNavMonth.js`：`endMonth = endOfYear(today)`），单值选择器就因此选不了
 * 明年及以后的日期（#264）。现在默认**不设上下限**，要限制就显式传 `startMonth` / `endMonth`。
 *
 * 语言跟随界面（`useLang()` → `react-day-picker/locale`），调用方传 `locale` 可以覆盖。
 */

/** 界面语言 → 日历语言。`packages/i18n` 的 `LANGUAGES` 加一种语言，这里就要加一项 */
const LOCALES = { "zh-CN": zhCN, "en-US": enUS } as const satisfies Record<string, Locale>
const LOCALE_KEYS = Object.keys(LOCALES) as (keyof typeof LOCALES)[]

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type CalendarProps = DistributiveOmit<
  React.ComponentProps<typeof DayPicker>,
  "captionLayout" | "hideNavigation"
> & {
  buttonVariant?: React.ComponentProps<typeof Button>["variant"]
}

type View =
  | { kind: "day" }
  | { kind: "month"; year: number; panel: number }
  | { kind: "year"; year: number; panel: number }

interface NavState {
  month: Date
  numberOfMonths: number
  bounds: MonthBounds
  localeCode: string | undefined
  yearFirst: boolean
  fmtYear: (d: Date) => string
  fmtMonth: (d: Date) => string
  shift: (delta: number) => void
  open: (v: View) => void
  /** 从年 / 月面板回到日视图之后，把焦点还给第几个面板的月份标签 */
  focusPanel: number | null
  clearFocus: () => void
  buttonVariant: React.ComponentProps<typeof Button>["variant"]
}

const NavContext = React.createContext<NavState | null>(null)

function useFormatters(code: string | undefined) {
  return React.useMemo(() => {
    const y = new Intl.DateTimeFormat(code, { year: "numeric" })
    const m = new Intl.DateTimeFormat(code, { month: "short" })
    return { fmtYear: (d: Date) => y.format(d), fmtMonth: (d: Date) => m.format(d) }
  }, [code])
}

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  buttonVariant = "ghost",
  locale,
  components,
  month: monthProp,
  onMonthChange,
  defaultMonth,
  startMonth,
  endMonth,
  numberOfMonths = 1,
  today,
  ...props
}: CalendarProps) {
  const t = useT()
  const lang = useLang()
  const defaultClassNames = getDefaultClassNames()
  const resolvedLocale: Partial<Locale> = locale ?? LOCALES[pickLocaleKey(lang, LOCALE_KEYS) ?? "en-US"]
  const localeCode = resolvedLocale.code ?? lang
  const { fmtYear, fmtMonth } = useFormatters(localeCode)
  const bounds: MonthBounds = { startMonth, endMonth }

  const [innerMonth, setInnerMonth] = React.useState(() =>
    clampFirstMonth(
      initialMonth({ defaultMonth, selected: (props as { selected?: unknown }).selected, today }),
      numberOfMonths,
      bounds
    )
  )
  const month = monthProp ? startOfMonth(monthProp) : innerMonth
  const setMonth = (m: Date) => {
    const next = clampFirstMonth(m, numberOfMonths, bounds)
    if (monthProp === undefined) setInnerMonth(next)
    onMonthChange?.(next)
  }

  const [view, setView] = React.useState<View>({ kind: "day" })
  const [focusPanel, setFocusPanel] = React.useState<number | null>(null)
  const rootRef = React.useRef<HTMLDivElement>(null)
  /** 切到年 / 月面板时锁住日视图的尺寸 —— 不锁的话浮层会跟着缩一下再弹回来 */
  const [frame, setFrame] = React.useState<{ w: number; h: number } | null>(null)

  const open = (v: View) => {
    if (view.kind === "day" && rootRef.current) {
      setFrame({ w: rootRef.current.offsetWidth, h: rootRef.current.offsetHeight })
    }
    setView(v)
  }
  const backToDay = (first: Date | null, panel: number) => {
    if (first) setMonth(first)
    setView({ kind: "day" })
    setFocusPanel(panel)
  }

  const nav: NavState = {
    month,
    numberOfMonths,
    bounds,
    localeCode,
    yearFirst: yearFirst(localeCode),
    fmtYear,
    fmtMonth,
    shift: (delta) => setMonth(addMonths(month, delta)),
    open,
    focusPanel,
    clearFocus: () => setFocusPanel(null),
    buttonVariant,
  }

  return (
    <NavContext.Provider value={nav}>
      <div
        data-slot="calendar"
        data-view={view.kind}
        ref={rootRef}
        dir={props.dir}
        style={view.kind !== "day" && frame ? { width: frame.w, minHeight: frame.h } : undefined}
        className={cn(
          "group/calendar w-fit bg-background p-3 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(8)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent",
          className
        )}
      >
        {view.kind === "day" ? (
          <DayPicker
            showOutsideDays={showOutsideDays}
            locale={resolvedLocale}
            month={month}
            onMonthChange={setMonth}
            startMonth={startMonth}
            endMonth={endMonth}
            numberOfMonths={numberOfMonths}
            today={today}
            hideNavigation
            classNames={{
              root: cn("w-fit", defaultClassNames.root),
              months: cn("relative flex flex-col gap-4 md:flex-row", defaultClassNames.months),
              month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
              month_caption: cn("flex h-(--cell-size) w-full items-center gap-0.5", defaultClassNames.month_caption),
              caption_label: cn("text-sm font-medium select-none", defaultClassNames.caption_label),
              month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
              weekdays: cn("flex", defaultClassNames.weekdays),
              weekday: cn(
                "flex-1 rounded-(--cell-radius) text-[0.8rem] font-normal text-muted-foreground select-none",
                defaultClassNames.weekday
              ),
              week: cn("mt-2 flex w-full", defaultClassNames.week),
              week_number_header: cn("w-(--cell-size) select-none", defaultClassNames.week_number_header),
              week_number: cn("text-[0.8rem] text-muted-foreground select-none", defaultClassNames.week_number),
              day: cn(
                "group/day relative aspect-square h-full w-full rounded-(--cell-radius) p-0 text-center select-none [&:last-child[data-selected=true]_button]:rounded-e-(--cell-radius)",
                props.showWeekNumber
                  ? "[&:nth-child(2)[data-selected=true]_button]:rounded-s-(--cell-radius)"
                  : "[&:first-child[data-selected=true]_button]:rounded-s-(--cell-radius)",
                defaultClassNames.day
              ),
              range_start: cn(
                "relative isolate z-0 rounded-s-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:end-0 after:w-4 after:bg-muted",
                defaultClassNames.range_start
              ),
              range_middle: cn("rounded-none", defaultClassNames.range_middle),
              range_end: cn(
                "relative isolate z-0 rounded-e-(--cell-radius) bg-muted after:absolute after:inset-y-0 after:start-0 after:w-4 after:bg-muted",
                defaultClassNames.range_end
              ),
              today: cn(
                "rounded-(--cell-radius) bg-muted text-foreground data-[selected=true]:rounded-none",
                defaultClassNames.today
              ),
              outside: cn("text-muted-foreground aria-selected:text-muted-foreground", defaultClassNames.outside),
              disabled: cn("text-muted-foreground opacity-50", defaultClassNames.disabled),
              hidden: cn("invisible", defaultClassNames.hidden),
              ...classNames,
            }}
            components={{
              MonthCaption: CalendarCaption,
              Chevron: CalendarChevron,
              DayButton: CalendarDayButton,
              WeekNumber: CalendarWeekNumber,
              ...components,
            }}
            {...props}
          />
        ) : (
          <PanelGrid
            view={view}
            bounds={bounds}
            fmtYear={fmtYear}
            fmtMonth={fmtMonth}
            buttonVariant={buttonVariant}
            t={t}
            onView={setView}
            onPick={(kind, year, value) =>
              kind === "year"
                ? setView({ kind: "month", year: value, panel: view.panel })
                : backToDay(firstMonthForPanel(year, value, view.panel), view.panel)
            }
            onCancel={() => backToDay(null, view.panel)}
            isCurrent={(kind, serial) => {
              /** 进面板时那个面板正显示的月份 —— 面板里高亮它 */
              const shown = addMonths(month, view.panel)
              return serial === (kind === "year" ? shown.getFullYear() : monthSerial(shown))
            }}
          />
        )}
      </div>
    </NavContext.Provider>
  )
}

/* ------------------------------------------------------------------ 日视图表头 */

const headerLabel =
  "inline-flex h-7 items-center rounded-(--cell-radius) px-1.5 text-sm font-medium outline-none select-none hover:bg-muted hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"

function NavButton({
  delta,
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  delta: number
  label: string
  icon: React.ComponentType<{ className?: string }>
  disabled: boolean
  onClick: () => void
}) {
  const variant = React.useContext(NavContext)?.buttonVariant ?? "ghost"
  return (
    <Button
      type="button"
      variant={variant}
      size="icon"
      className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
      aria-label={label}
      data-nav={delta}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="size-4 rtl:rotate-180" />
    </Button>
  )
}

/** 占位：双月时左面板没有 › »、右面板没有 « ‹，占住宽度让年月标签居中 */
const NavSpacer = () => <span aria-hidden className="size-7 shrink-0" />

function CalendarCaption({ calendarMonth, displayIndex, className, children, ...rest }: MonthCaptionProps) {
  const t = useT()
  const nav = React.useContext(NavContext)
  const monthBtn = React.useRef<HTMLButtonElement>(null)
  const focusMe = nav?.focusPanel === displayIndex

  React.useEffect(() => {
    if (!focusMe) return
    monthBtn.current?.focus()
    nav?.clearFocus()
  }, [focusMe, nav])

  // 被直接拿去当 react-day-picker 的组件用（不在 Calendar 里）时，退回只显示标题
  if (!nav) return <div className={className} {...rest}>{children}</div>

  const d = calendarMonth.date
  const isFirst = displayIndex === 0
  const isLast = displayIndex === nav.numberOfMonths - 1
  const can = (delta: number) => canShift(nav.month, delta, nav.numberOfMonths, nav.bounds)
  const panelArgs = { year: d.getFullYear(), panel: displayIndex }

  const yearBtn = (
    <button
      key="y"
      type="button"
      className={headerLabel}
      aria-label={t("选择年份")}
      data-testid="calendar-year"
      onClick={() => nav.open({ kind: "year", ...panelArgs })}
    >
      {nav.fmtYear(d)}
    </button>
  )
  const monthBtnEl = (
    <button
      key="m"
      ref={monthBtn}
      type="button"
      className={headerLabel}
      aria-label={t("选择月份")}
      data-testid="calendar-month"
      onClick={() => nav.open({ kind: "month", ...panelArgs })}
    >
      {nav.fmtMonth(d)}
    </button>
  )

  return (
    <div className={className} {...rest}>
      {isFirst ? (
        <>
          <NavButton delta={-12} label={t("上一年")} icon={IconChevronsLeft} disabled={!can(-12)} onClick={() => nav.shift(-12)} />
          <NavButton delta={-1} label={t("上个月")} icon={IconChevronLeft} disabled={!can(-1)} onClick={() => nav.shift(-1)} />
        </>
      ) : (
        <><NavSpacer /><NavSpacer /></>
      )}
      <div className="flex min-w-0 flex-1 items-center justify-center" aria-live="polite">
        {nav.yearFirst ? [yearBtn, monthBtnEl] : [monthBtnEl, yearBtn]}
      </div>
      {isLast ? (
        <>
          <NavButton delta={1} label={t("下个月")} icon={IconChevronRight} disabled={!can(1)} onClick={() => nav.shift(1)} />
          <NavButton delta={12} label={t("下一年")} icon={IconChevronsRight} disabled={!can(12)} onClick={() => nav.shift(12)} />
        </>
      ) : (
        <><NavSpacer /><NavSpacer /></>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ 年 / 月面板 */

type PanelKind = "month" | "year"

/** 区间里这一格的位置：两端 / 中间。`preview` = 鼠标悬停预览出来的，还没点 */
type RangeMark = { edge?: boolean; middle?: boolean; preview?: boolean }

/** 年格的序号是年份，月格是 `year * 12 + month` —— 同一种格子之间才比较 */
const cellSerial = (kind: PanelKind, year: number, value: number) => (kind === "year" ? value : year * 12 + value)

function PanelGrid({
  view,
  bounds,
  fmtYear,
  fmtMonth,
  buttonVariant,
  t,
  onView,
  onPick,
  onCancel,
  isCurrent,
  rangeMark,
  onHover,
}: {
  view: Exclude<View, { kind: "day" }>
  bounds: MonthBounds
  fmtYear: (d: Date) => string
  fmtMonth: (d: Date) => string
  buttonVariant: React.ComponentProps<typeof Button>["variant"]
  t: (k: string) => string
  onView: (v: View) => void
  /** 点了一格：年面板 `value` 是年份，月面板是 0–11 */
  onPick: (kind: PanelKind, year: number, value: number) => void
  /** 给了就拦 Esc（日历里是「退回日视图」）；不给就让 Esc 照常关浮层 */
  onCancel?: () => void
  isCurrent: (kind: PanelKind, serial: number) => boolean
  rangeMark?: (kind: PanelKind, serial: number) => RangeMark | undefined
  onHover?: (kind: PanelKind, serial: number | undefined) => void
}) {
  const gridRef = React.useRef<HTMLDivElement>(null)
  const now = new Date()
  const minY = bounds.startMonth?.getFullYear()
  const maxY = bounds.endMonth?.getFullYear()

  // 换面板（日→月、月→年…）时把焦点放到当前格；同一面板里翻页不动焦点，连点 « 不会被打断
  React.useEffect(() => {
    const g = gridRef.current
    if (!g) return
    const target =
      g.querySelector<HTMLButtonElement>('[data-current="true"]:not(:disabled)') ??
      g.querySelector<HTMLButtonElement>("[data-cell]:not(:disabled)")
    target?.focus()
  }, [view.kind])

  const kind = view.kind
  const isYear = kind === "year"
  const start = decadeStart(view.year)
  const cells = isYear ? yearCells(view.year, bounds) : monthCells(view.year, bounds)
  const step = isYear ? 10 : 1
  const canPrev = minY === undefined || (isYear ? start - 1 >= minY : view.year - 1 >= minY)
  const canNext = maxY === undefined || (isYear ? start + 10 <= maxY : view.year + 1 <= maxY)
  const nowSerial = isYear ? now.getFullYear() : monthSerial(now)

  return (
    <div
      ref={gridRef}
      data-testid={`calendar-${kind}-panel`}
      className="flex h-full flex-col gap-3"
      onKeyDown={(e) => {
        // Esc 先退回日视图，不要一下把整个浮层关掉
        if (e.key !== "Escape" || !onCancel) return
        e.preventDefault()
        e.stopPropagation()
        onCancel()
      }}
    >
      <div className="flex h-(--cell-size) items-center gap-0.5">
        <NavButtonStatic
          variant={buttonVariant}
          label={isYear ? t("前十年") : t("上一年")}
          icon={IconChevronsLeft}
          disabled={!canPrev}
          onClick={() => onView({ ...view, year: view.year - step })}
        />
        <div className="flex min-w-0 flex-1 items-center justify-center" aria-live="polite">
          {isYear ? (
            <span className="text-sm font-medium select-none" data-testid="calendar-decade">
              {start} – {start + 9}
            </span>
          ) : (
            <button
              type="button"
              className={headerLabel}
              aria-label={t("选择年份")}
              data-testid="calendar-year"
              onClick={() => onView({ kind: "year", year: view.year, panel: view.panel })}
            >
              {fmtYear(new Date(view.year, 0, 1))}
            </button>
          )}
        </div>
        <NavButtonStatic
          variant={buttonVariant}
          label={isYear ? t("后十年") : t("下一年")}
          icon={IconChevronsRight}
          disabled={!canNext}
          onClick={() => onView({ ...view, year: view.year + step })}
        />
      </div>

      <div
        role="grid"
        className="grid flex-1 grid-cols-3 content-around gap-y-2"
        onMouseLeave={() => onHover?.(kind, undefined)}
      >
        {cells.map((c) => {
          const serial = cellSerial(kind, view.year, c.value)
          const current = isCurrent(kind, serial)
          const mark = rangeMark?.(kind, serial)
          return (
            <div
              key={c.value}
              // 区间中间那段的底色铺在格子外层，连成一条，和日视图的区间一个样子
              className={cn(
                "flex items-center justify-center px-0.5",
                mark?.middle && (mark.preview ? "bg-primary/10" : "bg-muted")
              )}
            >
              <button
                type="button"
                role="gridcell"
                data-cell={c.value}
                data-current={current}
                data-range={mark?.edge ? "edge" : mark?.middle ? "middle" : undefined}
                disabled={c.disabled}
                aria-selected={current}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "h-9 w-full font-normal",
                  c.outside && "text-muted-foreground",
                  serial === nowSerial && !current && "font-medium text-primary",
                  mark?.middle && "hover:bg-background/60",
                  current && "bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
                  c.disabled && "opacity-50"
                )}
                onMouseEnter={() => onHover?.(kind, serial)}
                onClick={() => onPick(kind, view.year, c.value)}
              >
                {isYear ? c.value : fmtMonth(new Date(view.year, c.value, 1))}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NavButtonStatic({
  variant,
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  variant: React.ComponentProps<typeof Button>["variant"]
  label: string
  icon: React.ComponentType<{ className?: string }>
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant={variant}
      size="icon"
      className="size-7 shrink-0 p-0 text-muted-foreground hover:text-foreground"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon className="size-4 rtl:rotate-180" />
    </Button>
  )
}

/* ------------------------------------------------------------------ 按月 / 按年 */

export type PeriodCalendarProps = {
  /** `month`：月面板，点年份进年面板；`year`：只有年面板 */
  picker: PanelKind
  /** 单值是一个 Date；区间是 `{from, to}`，`to` 为空 = 在等第二下（悬停时预览） */
  selected?: Date | { from?: Date; to?: Date }
  /** 点了一格：按月给那个月的 1 日，按年给那年的 1 月 1 日 */
  onPick: (d: Date) => void
  startMonth?: Date
  endMonth?: Date
  /** 打开时先显示哪一年。不给就按已选的值 / 今天 */
  defaultMonth?: Date
  buttonVariant?: React.ComponentProps<typeof Button>["variant"]
  className?: string
}

/**
 * 按月 / 按年选（#266 的「粒度」）：直接复用日历里的月 / 年面板，不另画一套。
 *
 * 只做「点哪格给哪格」和高亮，值的形状（单值 `'YYYY-MM'`、区间取整段边界）
 * 归 `datetime-picker` 管 —— 见 `datetime-picker-state.ts` 的 `formatPeriod` / `periodRange`。
 */
export function PeriodCalendar({
  picker,
  selected,
  onPick,
  startMonth,
  endMonth,
  defaultMonth,
  buttonVariant = "ghost",
  className,
}: PeriodCalendarProps) {
  const t = useT()
  const lang = useLang()
  const localeCode = LOCALES[pickLocaleKey(lang, LOCALE_KEYS) ?? "en-US"].code ?? lang
  const { fmtYear, fmtMonth } = useFormatters(localeCode)
  const bounds: MonthBounds = { startMonth, endMonth }

  const range = selected && !(selected instanceof Date) ? selected : undefined
  const single = selected instanceof Date ? selected : undefined
  const first = initialMonth({ defaultMonth, selected })
  const [view, setView] = React.useState<Exclude<View, { kind: "day" }>>({ kind: picker, year: first.getFullYear(), panel: 0 })
  const [hover, setHover] = React.useState<{ kind: PanelKind; serial: number } | undefined>()

  const serialOf = (kind: PanelKind, d: Date | undefined) =>
    d === undefined ? undefined : kind === "year" ? d.getFullYear() : monthSerial(d)

  return (
    <div
      data-slot="calendar"
      data-view={view.kind}
      className={cn(
        "group/calendar w-62 bg-background p-3 [--cell-radius:var(--radius-md)] [--cell-size:--spacing(8)] in-data-[slot=card-content]:bg-transparent in-data-[slot=popover-content]:bg-transparent",
        className
      )}
    >
      <PanelGrid
        view={view}
        bounds={bounds}
        fmtYear={fmtYear}
        fmtMonth={fmtMonth}
        buttonVariant={buttonVariant}
        t={t}
        onView={(v) => v.kind !== "day" && setView(v)}
        onPick={(kind, year, value) => {
          // 按月时点了某一年 = 进那一年的月面板，还没选完
          if (kind === "year" && picker === "month") return setView({ kind: "month", year: value, panel: 0 })
          onPick(kind === "year" ? new Date(value, 0, 1) : new Date(year, value, 1))
        }}
        isCurrent={(kind, serial) => {
          if (single) return serial === serialOf(kind, single)
          return serial === serialOf(kind, range?.from) || serial === serialOf(kind, range?.to)
        }}
        rangeMark={(kind, serial) => {
          if (!range?.from) return undefined
          const a = serialOf(kind, range.from)!
          const pending = !range.to
          const b = pending ? (hover?.kind === kind ? hover.serial : undefined) : serialOf(kind, range.to)
          if (b === undefined) return undefined
          const [lo, hi] = a <= b ? [a, b] : [b, a]
          if (serial < lo || serial > hi) return undefined
          return { edge: serial === lo || serial === hi, middle: serial > lo && serial < hi, preview: pending }
        }}
        onHover={(kind, serial) => setHover(serial === undefined ? undefined : { kind, serial })}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ 其余子组件 */

function CalendarChevron({
  className,
  orientation,
}: { className?: string; orientation?: "up" | "down" | "left" | "right"; size?: number; disabled?: boolean }) {
  // 只取 className / orientation：react-day-picker 还会传 size / disabled，透传到 svg 上没意义
  if (orientation === "left") return <IconChevronLeft className={cn("size-4 rtl:rotate-180", className)} />
  if (orientation === "right") return <IconChevronRight className={cn("size-4 rtl:rotate-180", className)} />
  return <IconChevronDown className={cn("size-4", className)} />
}

function CalendarWeekNumber({
  children,
  week,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { week?: { weekNumber?: number } }) {
  // `week` 是对象，原样透传到 <td> 上会变成 week="[object Object]"
  return (
    <td {...props} data-week={week?.weekNumber}>
      <div className="flex size-(--cell-size) items-center justify-center text-center">{children}</div>
    </td>
  )
}

function CalendarDayButton({
  className,
  day,
  modifiers,
  locale,
  ...props
}: React.ComponentProps<typeof DayButton> & { locale?: Partial<Locale> }) {
  const defaultClassNames = getDefaultClassNames()
  const nav = React.useContext(NavContext)
  const code = locale?.code ?? nav?.localeCode

  const ref = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus()
  }, [modifiers.focused])

  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon"
      data-day={day.date.toLocaleDateString(code)}
      data-selected-single={
        modifiers.selected &&
        !modifiers.range_start &&
        !modifiers.range_end &&
        !modifiers.range_middle
      }
      data-range-start={modifiers.range_start}
      data-range-end={modifiers.range_end}
      data-range-middle={modifiers.range_middle}
      className={cn(
        "relative isolate z-10 flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 border-0 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 data-[range-end=true]:rounded-(--cell-radius) data-[range-end=true]:rounded-e-(--cell-radius) data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-muted data-[range-middle=true]:text-foreground data-[range-start=true]:rounded-(--cell-radius) data-[range-start=true]:rounded-s-(--cell-radius) data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground dark:hover:text-foreground [&>span]:text-xs [&>span]:opacity-70",
        defaultClassNames.day,
        className
      )}
      {...props}
    />
  )
}

export { Calendar, CalendarDayButton }
