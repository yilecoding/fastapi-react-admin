/**
 * `TimeColumns` / `TimePicker` 的纯逻辑：三列的选项、步长对齐、禁用项、手输解析。
 *
 * 值的形状和 `datetime-picker` 一致：`'HH:mm:ss'` 本地时间串，24 小时制。
 * 不跟浏览器 / 系统的 12 小时制走 —— 那正是原生 `<input type="time">` 被换掉的原因（#266）：
 * 同一个页面在不同人的电脑上显示成 `14:00` 和 `02:00 PM` 两种样子。
 */

const p2 = (n: number) => String(n).padStart(2, "0")

export type TimeUnit = "hour" | "minute" | "second"

export interface TimeSteps {
  hourStep?: number
  minuteStep?: number
  secondStep?: number
}

export interface TimeDisabled {
  /** 返回要禁用的小时 */
  disabledHours?: () => readonly number[]
  /** 返回在 `hour` 这一小时里要禁用的分钟 */
  disabledMinutes?: (hour: number) => readonly number[]
  /** 返回在 `hour:minute` 这一分钟里要禁用的秒 */
  disabledSeconds?: (hour: number, minute: number) => readonly number[]
}

export type TimeTuple = readonly [h: number, m: number, s: number]

/** 一列的选项：`0, step, 2·step …`，不超过 `max - 1`。`step` 非法（≤0 / 非整数）按 1 处理 */
export function unitOptions(max: number, step = 1): number[] {
  const s = Number.isInteger(step) && step > 0 ? step : 1
  const out: number[] = []
  for (let v = 0; v < max; v += s) out.push(v)
  return out
}

/** `'HH:mm[:ss]'` → `[h, m, s]`；不合法给 undefined */
export function splitTime(v: string | undefined | null): TimeTuple | undefined {
  const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec((v ?? "").trim())
  if (!m) return undefined
  const t = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] as const
  return t[0] <= 23 && t[1] <= 59 && t[2] <= 59 ? t : undefined
}

export const joinTime = ([h, m, s]: TimeTuple): string => `${p2(h)}:${p2(m)}:${p2(s)}`

/** 向下对齐到步长：步长 15 分钟时 `10:07` → `10:00`。「此刻」要落在选项上，不然三列里没有一格是选中的 */
export function snapTime([h, m, s]: TimeTuple, steps: TimeSteps = {}): TimeTuple {
  const snap = (v: number, step = 1) => (Number.isInteger(step) && step > 1 ? v - (v % step) : v)
  return [snap(h, steps.hourStep), snap(m, steps.minuteStep), snap(s, steps.secondStep)]
}

/** 这个时刻有没有被禁用（任意一列落在禁用项里都算） */
export function isTimeDisabled([h, m, s]: TimeTuple, d: TimeDisabled = {}): boolean {
  return (
    (d.disabledHours?.().includes(h) ?? false) ||
    (d.disabledMinutes?.(h).includes(m) ?? false) ||
    (d.disabledSeconds?.(h, m).includes(s) ?? false)
  )
}

/**
 * 在某一列里换了一格之后的时刻。
 *
 * 只换那一列 —— 换了小时之后分钟落进了新小时的禁用项，**不偷偷改分钟**：
 * 那一格会显示成选中 + 禁用，「确定」灰掉，让人自己看见并改。偷偷改的话，
 * 用户点的是 10 点、拿到的是 10:15，而他没碰过分钟那一列。
 */
export function setUnit(t: TimeTuple, unit: TimeUnit, v: number): TimeTuple {
  if (unit === "hour") return [v, t[1], t[2]]
  if (unit === "minute") return [t[0], v, t[2]]
  return [t[0], t[1], v]
}

/**
 * 手输 → `'HH:mm:ss'`；不合法给 `null`。
 *
 * 认 `14:05` / `14:05:30` / `9:5` / `1405` / `140530` / `14`（整点）。
 * 不认 `2pm` —— 本组件刻意只有 24 小时制。
 */
export function parseTimeTyped(text: string): string | null {
  const s = text.trim()
  if (!s) return null
  const colon = splitTime(s)
  if (colon) return joinTime(colon)
  const m = /^(\d{1,2})(\d{2})?(\d{2})?$/.exec(s)
  // 「930」：正则回溯成 9 + 30，按 9:30 读，不会读成 93 点
  if (!m) return null
  const t = [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] as const
  return t[0] <= 23 && t[1] <= 59 && t[2] <= 59 ? joinTime(t) : null
}
