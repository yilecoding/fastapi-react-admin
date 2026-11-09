import { describe, expect, it } from "vitest"

import {
  formatPeriod,
  parsePeriod,
  parseTyped,
  periodRange,
  pickRangeDay,
  previewRange,
  type RangeDraft,
} from "./datetime-picker-state"

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day)
const key = (x: Date | undefined) => (x ? `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}` : undefined)
const show = (r: RangeDraft) => ({ from: key(r.from), to: key(r.to), pending: r.pending })

describe("pickRangeDay", () => {
  it("第一下只定起点、等第二下 —— 不是 from === to 的完整区间", () => {
    expect(show(pickRangeDay({ pending: false }, d(2026, 11, 3)))).toEqual({ from: "2026-11-3", to: undefined, pending: true })
  })

  it("第二下在后面 → 完整区间", () => {
    const r = pickRangeDay({ from: d(2026, 10, 1), pending: true }, d(2026, 10, 10))
    expect(show(r)).toEqual({ from: "2026-10-1", to: "2026-10-10", pending: false })
  })

  it("第二下在前面 → 对调", () => {
    const r = pickRangeDay({ from: d(2026, 10, 10), pending: true }, d(2026, 10, 1))
    expect(show(r)).toEqual({ from: "2026-10-1", to: "2026-10-10", pending: false })
  })

  it("两下点同一天 → 单日区间", () => {
    const r = pickRangeDay({ from: d(2026, 10, 1), pending: true }, d(2026, 10, 1))
    expect(show(r)).toEqual({ from: "2026-10-1", to: "2026-10-1", pending: false })
  })

  it("已选好 10-01 ~ 10-10 再点 10-20 → 从 10-20 重新开始，不是拉长成 10-01 ~ 10-20（#266）", () => {
    const done: RangeDraft = { from: d(2026, 10, 1), to: d(2026, 10, 10), pending: false }
    expect(show(pickRangeDay(done, d(2026, 10, 20)))).toEqual({ from: "2026-10-20", to: undefined, pending: true })
  })

  it("只比日期，不被时分秒干扰", () => {
    const r = pickRangeDay({ from: new Date(2026, 9, 1, 23, 0), pending: true }, new Date(2026, 9, 1, 1, 0))
    expect(r.pending).toBe(false)
    expect(key(r.from)).toBe("2026-10-1")
  })
})

describe("previewRange", () => {
  it("等第二下时按悬停位置预览，且排好前后", () => {
    const draft: RangeDraft = { from: d(2026, 10, 10), pending: true }
    const p = previewRange(draft, d(2026, 10, 3))
    expect([key(p?.from), key(p?.to)]).toEqual(["2026-10-3", "2026-10-10"])
  })

  it("不在等第二下 / 没有悬停 → 不预览", () => {
    expect(previewRange({ from: d(2026, 10, 1), to: d(2026, 10, 2), pending: false }, d(2026, 10, 5))).toBeUndefined()
    expect(previewRange({ from: d(2026, 10, 1), pending: true }, undefined)).toBeUndefined()
  })
})

describe("parseTyped", () => {
  it("认常见的分隔符和不写分隔符", () => {
    expect(parseTyped("2026-11-09")).toBe("2026-11-09")
    expect(parseTyped("2026/11/9")).toBe("2026-11-09")
    expect(parseTyped("2026.1.5")).toBe("2026-01-05")
    expect(parseTyped("20261109")).toBe("2026-11-09")
    expect(parseTyped("  2026-11-09  ")).toBe("2026-11-09")
  })

  it("不存在的日期拒收，而不是被 Date 进位成别的日子", () => {
    expect(parseTyped("2026-02-30")).toBeNull()
    expect(parseTyped("2026-13-01")).toBeNull()
    expect(parseTyped("2028-02-29")).toBe("2028-02-29")
  })

  it("不带时间的控件丢掉敲进来的时间", () => {
    expect(parseTyped("2026-11-09 14:00")).toBe("2026-11-09")
  })

  it("带时间：补齐秒；没写时间用 defaultTime", () => {
    expect(parseTyped("2026-11-09 14:00", { withTime: true })).toBe("2026-11-09 14:00:00")
    expect(parseTyped("2026-11-09T9:5:7", { withTime: true })).toBe("2026-11-09 09:05:07")
    expect(parseTyped("2026-11-09", { withTime: true })).toBe("2026-11-09 00:00:00")
    expect(parseTyped("2026-11-09", { withTime: true, defaultTime: "23:59:59" })).toBe("2026-11-09 23:59:59")
    expect(parseTyped("2026-11-09 24:00", { withTime: true })).toBeNull()
  })

  it("乱写的给 null", () => {
    expect(parseTyped("")).toBeNull()
    expect(parseTyped("明天")).toBeNull()
    expect(parseTyped("2026-11")).toBeNull()
  })

  it("按月 / 按年", () => {
    expect(parseTyped("2026-3", { picker: "month" })).toBe("2026-03")
    expect(parseTyped("202611", { picker: "month" })).toBe("2026-11")
    expect(parseTyped("2026-13", { picker: "month" })).toBeNull()
    expect(parseTyped("2026", { picker: "year" })).toBe("2026")
    expect(parseTyped("26", { picker: "year" })).toBeNull()
  })
})

describe("按月 / 按年的值形状", () => {
  it("单值：YYYY-MM / YYYY，来回不丢", () => {
    expect(formatPeriod(d(2026, 3, 15), "month")).toBe("2026-03")
    expect(formatPeriod(d(2026, 3, 15), "year")).toBe("2026")
    expect(key(parsePeriod("2026-03", "month"))).toBe("2026-3-1")
    expect(key(parsePeriod("2026", "year"))).toBe("2026-1-1")
    expect(parsePeriod("2026", "month")).toBeUndefined()
    expect(parsePeriod("2026-00", "month")).toBeUndefined()
  })

  it("区间：取整段边界，2 月取到 28 / 29 日，前后颠倒也对", () => {
    expect(periodRange(d(2026, 1, 1), d(2026, 2, 1), "month")).toEqual(["2026-01-01", "2026-02-28"])
    expect(periodRange(d(2028, 2, 1), d(2028, 2, 1), "month")).toEqual(["2028-02-01", "2028-02-29"])
    expect(periodRange(d(2027, 1, 1), d(2025, 1, 1), "year")).toEqual(["2025-01-01", "2027-12-31"])
    expect(periodRange(d(2026, 1, 1), d(2026, 1, 1), "month", true)).toEqual([
      "2026-01-01 00:00:00",
      "2026-01-31 23:59:59",
    ])
  })
})
