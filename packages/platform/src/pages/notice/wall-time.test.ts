import { afterEach, describe, expect, it } from 'vitest'

import { formatDateTime, setDisplayTimeZone } from '@admin/i18n'

import { toWallTime, wallTimeToIso } from './wall-time'

/**
 * 过期时间的选择器值按**显示时区**进出（不是浏览器时区）。
 * 测试进程的时区由 `TZ` 定，这里刻意把显示时区设成和它无关的几个，
 * 「碰巧和浏览器同一个时区所以对了」就测不出来。
 */
afterEach(() => setDisplayTimeZone(null))

describe('wallTimeToIso / toWallTime', () => {
  it('东八区：18:00 墙上时间 = 10:00Z', () => {
    setDisplayTimeZone('Asia/Shanghai')
    expect(wallTimeToIso('2026-11-01 18:00:00')).toBe('2026-11-01T10:00:00.000Z')
  })

  it('按显示时区解释，不按进程（浏览器）时区', () => {
    setDisplayTimeZone('America/Sao_Paulo')
    expect(wallTimeToIso('2026-11-01 18:00:00')).toBe('2026-11-01T21:00:00.000Z')
  })

  it('夏令时边界两侧都对（纽约 2026-03-08 02:00 跳到 03:00）', () => {
    setDisplayTimeZone('America/New_York')
    expect(wallTimeToIso('2026-03-07 12:00:00')).toBe('2026-03-07T17:00:00.000Z') // EST -5
    expect(wallTimeToIso('2026-03-09 12:00:00')).toBe('2026-03-09T16:00:00.000Z') // EDT -4
    // 估计值（03:30Z）还在切换点之前、按 EST 推出来是 08:30Z = 04:30 EDT —— 只推一次就差一小时，
    // 第二次复核才落到 07:30Z = 03:30 EDT
    expect(wallTimeToIso('2026-03-08 03:30:00')).toBe('2026-03-08T07:30:00.000Z')
  })

  it('来回一趟不变：接口的 ISO → 选择器 → ISO', () => {
    for (const tz of ['Asia/Shanghai', 'Europe/London', 'America/New_York', 'Asia/Kolkata']) {
      setDisplayTimeZone(tz)
      const iso = '2026-07-15T06:30:00.000Z'
      const wall = toWallTime('2026-07-15T06:30:00+00:00')
      expect(wall).toBe(formatDateTime(iso))
      expect(wallTimeToIso(wall)).toBe(iso)
    }
  })

  it('空值 / 坏值：不过期，不抛', () => {
    expect(wallTimeToIso(undefined)).toBeNull()
    expect(wallTimeToIso('')).toBeNull()
    expect(wallTimeToIso('2026-11-01')).toBeNull()
    expect(toWallTime(null)).toBeUndefined()
    expect(toWallTime('')).toBeUndefined()
  })
})
