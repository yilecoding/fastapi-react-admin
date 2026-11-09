/**
 * `Calendar` 的导航算术 —— 年 / 月面板的格子、跳月时夹在可选范围内、语言映射。
 *
 * 单独成文件是为了能在 node 环境下单测（本包不做组件渲染测试，见 `vitest.config.ts`）：
 * 这些都是「边界条件多、算错了不报错」的那一类 —— 年面板差一格、
 * 双月区间点右边那个月份标签之后左右错位，界面照样渲染得出来。
 */

/** 年 / 月面板里的一格 */
export interface PanelCell {
  /** 年面板是年份，月面板是 0–11 */
  value: number
  /** 年面板首尾那两格（上一个十年的最后一年 / 下一个十年的第一年），淡色显示 */
  outside: boolean
  /** 整格都落在 `startMonth`~`endMonth` 之外 */
  disabled: boolean
}

export interface MonthBounds {
  startMonth?: Date
  endMonth?: Date
}

/** 「第几个月」的线性序号，比较月份只比这个，不碰日和时分秒 */
export const monthSerial = (d: Date): number => d.getFullYear() * 12 + d.getMonth()

export const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1)

export const addMonths = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth() + n, 1)

/** 某年所在十年的首年：2026 → 2020 */
export const decadeStart = (year: number): number => Math.floor(year / 10) * 10

/**
 * 年面板 12 格：上一个十年的最后一年 + 这个十年 + 下一个十年的第一年。
 *
 * 和 antdv 一样排 3 列 × 4 行、首尾各借一格（Element Plus 是 10 格、末行只有两格）——
 * 借的那两格让「2029 → 2030」不用先翻页，点首尾格本身就是跨十年。
 */
export function yearCells(year: number, bounds: MonthBounds = {}): PanelCell[] {
  const start = decadeStart(year)
  const minY = bounds.startMonth?.getFullYear()
  const maxY = bounds.endMonth?.getFullYear()
  return Array.from({ length: 12 }, (_, i) => {
    const y = start - 1 + i
    return {
      value: y,
      outside: i === 0 || i === 11,
      disabled: (minY !== undefined && y < minY) || (maxY !== undefined && y > maxY),
    }
  })
}

/** 月面板 12 格 */
export function monthCells(year: number, bounds: MonthBounds = {}): PanelCell[] {
  const min = bounds.startMonth ? monthSerial(bounds.startMonth) : -Infinity
  const max = bounds.endMonth ? monthSerial(bounds.endMonth) : Infinity
  return Array.from({ length: 12 }, (_, m) => {
    const s = year * 12 + m
    return { value: m, outside: false, disabled: s < min || s > max }
  })
}

/**
 * 把「第一个显示的月份」夹进可选范围。
 *
 * 双月时要保证**最后一个**显示的月份也不越过 `endMonth`，所以上界是
 * `endMonth - (numberOfMonths - 1)`；范围比显示的月数还窄时以 `startMonth` 为准。
 */
export function clampFirstMonth(month: Date, numberOfMonths: number, bounds: MonthBounds = {}): Date {
  let s = monthSerial(month)
  if (bounds.endMonth) s = Math.min(s, monthSerial(bounds.endMonth) - (numberOfMonths - 1))
  if (bounds.startMonth) s = Math.max(s, monthSerial(bounds.startMonth))
  return new Date(Math.floor(s / 12), s % 12, 1)
}

/** 第一个显示的月份往前 / 往后挪 `delta` 个月之后，还在不在范围里（决定 «‹›» 灰不灰） */
export function canShift(month: Date, delta: number, numberOfMonths: number, bounds: MonthBounds = {}): boolean {
  const first = monthSerial(month) + delta
  const last = first + numberOfMonths - 1
  if (bounds.startMonth && first < monthSerial(bounds.startMonth)) return false
  if (bounds.endMonth && last > monthSerial(bounds.endMonth)) return false
  return true
}

/**
 * 在第 `panel` 个面板里选了 `year` 年 `month` 月 → 第一个显示的月份应该是哪个月。
 *
 * 双月区间点**右边**面板的月份标签、选了 3 月，要的是右边显示 3 月，
 * 所以第一个月是 2 月 —— 直接 `setMonth(3 月)` 会让 3 月跑到左边去。
 */
export function firstMonthForPanel(year: number, month: number, panel: number): Date {
  return new Date(year, month - panel, 1)
}

/**
 * 打开时先显示哪个月：调用方给的 `defaultMonth` > 已选的值 > 今天。
 *
 * 已选的值有三种形状（single 是 Date、multiple 是 Date[]、range 是 `{from, to}`），
 * 这里都认。**不夹 `startMonth`/`endMonth`** —— 交给 `clampFirstMonth`。
 */
export function initialMonth(opts: { defaultMonth?: Date; selected?: unknown; today?: Date }): Date {
  if (opts.defaultMonth) return startOfMonth(opts.defaultMonth)
  const s = opts.selected
  const first =
    s instanceof Date
      ? s
      : Array.isArray(s)
        ? (s.find((x): x is Date => x instanceof Date) ?? undefined)
        : s && typeof s === "object"
          ? ((s as { from?: Date; to?: Date }).from ?? (s as { to?: Date }).to)
          : undefined
  return startOfMonth(first instanceof Date && !Number.isNaN(first.getTime()) ? first : (opts.today ?? new Date()))
}

/**
 * 界面语言 → 日历语言表里的 key。先精确匹配（`zh-TW`），再按主语言匹配（`zh-SG` → `zh-CN`）。
 * 都匹配不上返回 `undefined`，由调用方决定回落到哪个。
 */
export function pickLocaleKey<K extends string>(lang: string | undefined, available: readonly K[]): K | undefined {
  if (!lang) return undefined
  const exact = available.find((k) => k.toLowerCase() === lang.toLowerCase())
  if (exact) return exact
  const primary = lang.split(/[-_]/)[0]!.toLowerCase()
  return available.find((k) => k.split("-")[0]!.toLowerCase() === primary)
}

/** 标题里「年」在「月」前面的语言（中日韩）：`2026年 11月` 而不是 `Nov 2026` */
export const yearFirst = (lang: string | undefined): boolean => /^(zh|ja|ko)\b/i.test(lang ?? "")
