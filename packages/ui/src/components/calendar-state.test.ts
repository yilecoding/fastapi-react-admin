import { describe, expect, it } from "vitest"
import {
  canShift,
  clampFirstMonth,
  decadeStart,
  firstMonthForPanel,
  initialMonth,
  monthCells,
  pickLocaleKey,
  yearCells,
  yearFirst,
} from "./calendar-state"

const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`

describe("yearCells", () => {
  it("12 格：上个十年的最后一年 + 本十年 + 下个十年的第一年", () => {
    const cells = yearCells(2026)
    expect(cells.map((c) => c.value)).toEqual([2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030])
    expect(cells.filter((c) => c.outside).map((c) => c.value)).toEqual([2019, 2030])
  })

  it("十年边界上的年份归本十年（2030 → 2030 年代，不是 2020 年代）", () => {
    expect(decadeStart(2030)).toBe(2030)
    expect(decadeStart(2029)).toBe(2020)
    expect(yearCells(2030)[1]!.value).toBe(2030)
  })

  it("没有范围时一格都不禁用 —— #264：不能默认锁到今年", () => {
    expect(yearCells(2099).some((c) => c.disabled)).toBe(false)
  })

  it("按 startMonth / endMonth 的年份禁用", () => {
    const cells = yearCells(2026, { startMonth: new Date(2021, 5, 1), endMonth: new Date(2027, 0, 1) })
    const disabled = cells.filter((c) => c.disabled).map((c) => c.value)
    expect(disabled).toEqual([2019, 2020, 2028, 2029, 2030])
  })
})

describe("monthCells", () => {
  it("按月粒度禁用，范围边界那个月本身可选", () => {
    const cells = monthCells(2026, { startMonth: new Date(2026, 2, 15), endMonth: new Date(2026, 9, 1) })
    expect(cells.filter((c) => !c.disabled).map((c) => c.value)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe("clampFirstMonth", () => {
  it("没有范围时原样返回（归到月初）", () => {
    expect(ym(clampFirstMonth(new Date(2031, 4, 20), 1))).toBe("2031-05")
  })

  it("双月时最后一个显示的月份也不能越过 endMonth", () => {
    const end = new Date(2026, 11, 1)
    expect(ym(clampFirstMonth(new Date(2026, 11, 1), 2, { endMonth: end }))).toBe("2026-11")
    expect(ym(clampFirstMonth(new Date(2026, 11, 1), 1, { endMonth: end }))).toBe("2026-12")
  })

  it("跨年回绕正确（1 月往前夹）", () => {
    expect(ym(clampFirstMonth(new Date(2025, 0, 1), 1, { startMonth: new Date(2025, 1, 1) }))).toBe("2025-02")
  })
})

describe("canShift", () => {
  it("« ‹ › » 在范围边上变灰，范围内可用", () => {
    const b = { startMonth: new Date(2026, 0, 1), endMonth: new Date(2026, 11, 1) }
    const m = new Date(2026, 5, 1)
    expect(canShift(m, -1, 1, b)).toBe(true)
    expect(canShift(m, -12, 1, b)).toBe(false)
    expect(canShift(m, 6, 1, b)).toBe(true)
    expect(canShift(m, 6, 2, b)).toBe(false) // 双月：右边那个月会跑到 2027-01
  })

  it("没有范围时翻到明年永远可以 —— #264 的回归点", () => {
    expect(canShift(new Date(2026, 11, 1), 1, 1)).toBe(true)
    expect(canShift(new Date(2026, 11, 1), 12, 2)).toBe(true)
  })
})

describe("firstMonthForPanel", () => {
  it("双月区间在右边面板选了 3 月 → 第一个月是 2 月，3 月留在右边", () => {
    expect(ym(firstMonthForPanel(2026, 2, 1))).toBe("2026-02")
  })

  it("右边面板选 1 月时第一个月回绕到去年 12 月", () => {
    expect(ym(firstMonthForPanel(2026, 0, 1))).toBe("2025-12")
  })

  it("左边面板就是自己", () => {
    expect(ym(firstMonthForPanel(2026, 7, 0))).toBe("2026-08")
  })
})

describe("initialMonth", () => {
  const today = new Date(2026, 10, 9)

  it("defaultMonth 优先", () => {
    expect(ym(initialMonth({ defaultMonth: new Date(2027, 5, 15), selected: new Date(2020, 0, 1), today }))).toBe("2027-06")
  })

  it("认三种 selected 形状", () => {
    expect(ym(initialMonth({ selected: new Date(2027, 5, 15), today }))).toBe("2027-06")
    expect(ym(initialMonth({ selected: [new Date(2024, 1, 3)], today }))).toBe("2024-02")
    expect(ym(initialMonth({ selected: { from: new Date(2025, 2, 1), to: new Date(2025, 3, 1) }, today }))).toBe("2025-03")
    expect(ym(initialMonth({ selected: { from: undefined, to: new Date(2025, 3, 1) }, today }))).toBe("2025-04")
  })

  it("没有值、或值是 Invalid Date 时回落今天", () => {
    expect(ym(initialMonth({ today }))).toBe("2026-11")
    expect(ym(initialMonth({ selected: new Date("nope"), today }))).toBe("2026-11")
  })
})

describe("pickLocaleKey / yearFirst", () => {
  const keys = ["zh-CN", "en-US"] as const

  it("精确匹配 → 主语言匹配 → 匹配不上给 undefined", () => {
    expect(pickLocaleKey("zh-CN", keys)).toBe("zh-CN")
    expect(pickLocaleKey("zh_SG", keys)).toBe("zh-CN")
    expect(pickLocaleKey("en", keys)).toBe("en-US")
    expect(pickLocaleKey("fr-FR", keys)).toBeUndefined()
    expect(pickLocaleKey(undefined, keys)).toBeUndefined()
  })

  it("中日韩年在前，其余月在前", () => {
    expect(yearFirst("zh-CN")).toBe(true)
    expect(yearFirst("ja")).toBe(true)
    expect(yearFirst("en-US")).toBe(false)
    expect(yearFirst(undefined)).toBe(false)
  })
})
