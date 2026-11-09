import { describe, expect, it } from "vitest"

import { isTimeDisabled, joinTime, parseTimeTyped, setUnit, snapTime, splitTime, unitOptions } from "./time-picker-state"

describe("unitOptions", () => {
  it("按步长生成，不超过上限", () => {
    expect(unitOptions(24)).toHaveLength(24)
    expect(unitOptions(60, 15)).toEqual([0, 15, 30, 45])
    expect(unitOptions(60, 7).at(-1)).toBe(56)
  })

  it("非法步长按 1 处理，而不是死循环 / 空列", () => {
    expect(unitOptions(5, 0)).toEqual([0, 1, 2, 3, 4])
    expect(unitOptions(5, -2)).toEqual([0, 1, 2, 3, 4])
    expect(unitOptions(5, 1.5)).toEqual([0, 1, 2, 3, 4])
  })
})

describe("splitTime / joinTime", () => {
  it("来回不丢、补零", () => {
    expect(splitTime("09:05")).toEqual([9, 5, 0])
    expect(joinTime(splitTime("9:5:7")!)).toBe("09:05:07")
  })

  it("越界的给 undefined", () => {
    expect(splitTime("24:00")).toBeUndefined()
    expect(splitTime("12:60")).toBeUndefined()
    expect(splitTime("")).toBeUndefined()
    expect(splitTime(undefined)).toBeUndefined()
  })
})

describe("snapTime", () => {
  it("向下对齐步长 —— 「此刻」才能落在某一格上", () => {
    expect(snapTime([10, 7, 42], { minuteStep: 15, secondStep: 30 })).toEqual([10, 0, 30])
    expect(snapTime([10, 7, 42])).toEqual([10, 7, 42])
  })
})

describe("isTimeDisabled / setUnit", () => {
  const rule = {
    disabledHours: () => [0, 1],
    disabledMinutes: (h: number) => (h === 12 ? [30] : []),
  }

  it("任意一列落在禁用项里都算禁用", () => {
    expect(isTimeDisabled([0, 0, 0], rule)).toBe(true)
    expect(isTimeDisabled([12, 30, 0], rule)).toBe(true)
    expect(isTimeDisabled([12, 15, 0], rule)).toBe(false)
  })

  it("换小时不偷偷改分钟 —— 落进禁用项就是禁用，让人看见", () => {
    const t = setUnit([11, 30, 0], "hour", 12)
    expect(t).toEqual([12, 30, 0])
    expect(isTimeDisabled(t, rule)).toBe(true)
  })
})

describe("parseTimeTyped", () => {
  it.each([
    ["14:05", "14:05:00"],
    ["14:05:30", "14:05:30"],
    ["9:5", "09:05:00"],
    ["1405", "14:05:00"],
    ["140530", "14:05:30"],
    ["930", "09:30:00"],
    ["14", "14:00:00"],
    [" 08:00 ", "08:00:00"],
  ])("%s → %s", (input, out) => {
    expect(parseTimeTyped(input)).toBe(out)
  })

  it.each(["", "24:00", "12:60", "2pm", "abc", "1:2:3:4", "2561"])("%s → null", (input) => {
    expect(parseTimeTyped(input)).toBeNull()
  })
})
