/**
 * `DateTimeValuePicker` / `DateTimeRangePicker` 的纯逻辑：值串的解析与拼装、
 * 区间点选的状态机、手输解析、按月 / 按年的值形状。
 *
 * 单独成文件是为了能在 node 环境下单测（本包不做组件渲染测试，见 `vitest.config.ts`），
 * 而这些恰好都是「边界条件多、算错了不报错」的：区间第二下点在第一下前面、
 * `2026-02-30` 被 `Date` 静默进位成 3 月 2 日、整月边界差一天，界面照样渲染得出来。
 *
 * 值的约定见 `datetime-picker.tsx` 头注释：对外一律是**本地时间串**，进出都不经过 Date。
 */

export const p2 = (n: number) => String(n).padStart(2, "0")

/** `Date` → `'YYYY-MM-DD'`（本地时区，不是 UTC） */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

/** `Date` → `'HH:mm:ss'`（本地时区） */
export function toTimeStr(d: Date): string {
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
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

/* ------------------------------------------------------------------ 区间点选 */

/**
 * 区间的点选草稿。`pending` = 已经点了第一下、在等第二下。
 *
 * 不用 react-day-picker 自己算出来的区间（`onSelect` 的第一个参数），只用它给的
 * `triggerDate`：它的规则是「已选好时再点 = 拉长原区间」，第一下就给出
 * `from === to` 的完整区间 —— 正是 #266 里实测到的两个问题的来源。
 */
export interface RangeDraft {
  from?: Date
  to?: Date
  pending: boolean
}

const dayKey = (d: Date) => d.getFullYear() * 10_000 + d.getMonth() * 100 + d.getDate()

/**
 * 点了一天之后的草稿：
 *
 * | 之前 | 点 | 之后 |
 * |---|---|---|
 * | 空 / 已选好 | d | `{from: d, pending}` —— **重新开始**（对齐 Element Plus / antdv） |
 * | `{from: a, pending}` | d ≥ a | `{from: a, to: d}` |
 * | `{from: a, pending}` | d < a | `{from: d, to: a}` —— 第二下点在前面就对调，不是丢掉 |
 */
export function pickRangeDay(draft: RangeDraft, d: Date): RangeDraft {
  if (!draft.pending || !draft.from) return { from: d, to: undefined, pending: true }
  return dayKey(d) < dayKey(draft.from)
    ? { from: d, to: draft.from, pending: false }
    : { from: draft.from, to: d, pending: false }
}

/** 等第二下时鼠标悬停在 `hover` 上 —— 预览出来的区间（已经排好前后） */
export function previewRange(draft: RangeDraft, hover: Date | undefined): { from: Date; to: Date } | undefined {
  if (!draft.pending || !draft.from || !hover) return undefined
  return dayKey(hover) < dayKey(draft.from)
    ? { from: hover, to: draft.from }
    : { from: draft.from, to: hover }
}

/* ------------------------------------------------------------------ 粒度 */

export type Picker = "date" | "month" | "year"

/**
 * 按月 / 按年时**单值**的形状：`'YYYY-MM'` / `'YYYY'`。
 *
 * 区间不用这个形状，用整段边界（见 `periodRange`）—— 区间几乎都是直接下发给
 * `between` 的，后端要的是 `2026-01-01 ~ 2026-03-31`，`2026-01 ~ 2026-03` 它不认。
 */
export function formatPeriod(d: Date, picker: Picker): string {
  if (picker === "year") return String(d.getFullYear())
  if (picker === "month") return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
  return toDateStr(d)
}

/** `formatPeriod` 的反向：认 `'YYYY'` / `'YYYY-MM'`，也认带日的完整串（取它所在的年 / 月） */
export function parsePeriod(s: string | undefined | null, picker: Picker): Date | undefined {
  if (!s) return undefined
  if (picker === "date") return parseDateStr(s)
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(s)
  if (!m) return undefined
  if (picker === "year") return new Date(Number(m[1]), 0, 1)
  if (!m[2]) return undefined
  const month = Number(m[2])
  return month >= 1 && month <= 12 ? new Date(Number(m[1]), month - 1, 1) : undefined
}

/** 按月 / 按年选出来的一段 → 值串：起点取那段的第一天，终点取最后一天 */
export function periodRange(from: Date, to: Date, picker: Picker, withTime = false): [string, string] {
  const [a, b] = dayKey(from) <= dayKey(to) ? [from, to] : [to, from]
  const first = picker === "year" ? new Date(a.getFullYear(), 0, 1) : new Date(a.getFullYear(), a.getMonth(), 1)
  const last = picker === "year" ? new Date(b.getFullYear(), 11, 31) : new Date(b.getFullYear(), b.getMonth() + 1, 0)
  return [stampValue(first, { withTime }), stampValue(last, { withTime, endOfDay: true })]
}

/* ------------------------------------------------------------------ 手输 */

/**
 * 输入框里敲的东西 → 规范化的值串；解析不出来给 `null`（调用方标红，不提交）。
 *
 * 宽进严出：分隔符认 `-` `/` `.` 和不写，时间认 `14:00` / `14:00:05` / `T14:00`，
 * 月和日可以只写一位。但**日期必须真实存在** —— `new Date(2026, 1, 30)` 会被
 * 静默进位成 3 月 2 日，这里要的是拒收而不是「帮你改成别的日子」。
 *
 * `withTime` 时没写时间就补 `defaultTime`（单值是 `00:00:00`，区间的结束端是 `23:59:59`）。
 */
export function parseTyped(
  text: string,
  opts: { picker?: Picker; withTime?: boolean; defaultTime?: string } = {}
): string | null {
  const s = text.trim()
  if (!s) return null
  const picker = opts.picker ?? "date"

  if (picker === "year") {
    return /^\d{4}$/.test(s) ? s : null
  }
  if (picker === "month") {
    const m = /^(\d{4})(?:[-/.]?(\d{1,2}))$/.exec(s)
    if (!m) return null
    const month = Number(m[2])
    return month >= 1 && month <= 12 ? `${m[1]}-${p2(month)}` : null
  }

  const m =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s) ??
    /^(\d{4})(\d{2})(\d{2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null

  if (!opts.withTime) return toDateStr(date)
  if (m[4] === undefined) return `${toDateStr(date)} ${opts.defaultTime ?? "00:00:00"}`
  const [h, mi, sec] = [Number(m[4]), Number(m[5]), Number(m[6] ?? 0)]
  if (h > 23 || mi > 59 || sec > 59) return null
  return `${toDateStr(date)} ${p2(h)}:${p2(mi)}:${p2(sec)}`
}
