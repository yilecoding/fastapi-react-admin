import { afterEach, describe, expect, it } from 'vitest'

import { formatDateTimeShort, setDisplayTimeZone } from '@admin/i18n'

/**
 * 审批中心 / 流程定义 / 审批轨迹用的短时间（#210 调研：不带年份，去年和今年的同一天分不出）。
 * 测在这里是因为 `@admin/i18n` 自己没有测试运行器。
 */
afterEach(() => setDisplayTimeZone(null))

const NOW = Date.parse('2026-11-02T10:00:00+08:00')

describe('formatDateTimeShort', () => {
  it('今年的省年份', () => {
    setDisplayTimeZone('Asia/Shanghai')
    expect(formatDateTimeShort('2026-08-22T11:59:00+08:00', { now: NOW })).toBe('08-22 11:59')
  })

  it('🔴 往年的补年份', () => {
    setDisplayTimeZone('Asia/Shanghai')
    expect(formatDateTimeShort('2025-12-30T09:00:00+08:00', { now: NOW })).toBe('2025-12-30 09:00')
  })

  it('「今年」按显示时区算：东八区元旦凌晨，UTC 还在去年，不补年份', () => {
    setDisplayTimeZone('Asia/Shanghai')
    const newYear = Date.parse('2027-01-01T00:30:00+08:00')
    expect(formatDateTimeShort('2027-01-01T00:10:00+08:00', { now: newYear })).toBe('01-01 00:10')
    expect(formatDateTimeShort('2026-12-31T23:50:00+08:00', { now: newYear })).toBe('2026-12-31 23:50')
  })

  it('🔴 被当回调传时（map 的下标 / 图表 tickFormatter 的 index），下标不会被当成「现在」', () => {
    setDisplayTimeZone('Asia/Shanghai')
    const thisYear = new Date().getFullYear()
    const at = `${thisYear}-06-15T12:00:00+08:00`
    // 模拟 arr.map(formatDateTimeShort) 传进来的 (value, index)
    const viaMap = [at].map(formatDateTimeShort as (v: string, i: number) => string)[0]
    expect(viaMap).toBe('06-15 12:00')
  })

  it('空值是占位符', () => {
    expect(formatDateTimeShort(null, { now: NOW })).toBe(formatDateTimeShort(undefined, { now: NOW }))
  })
})
