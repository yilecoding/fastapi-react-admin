import { afterEach, describe, expect, it, vi } from 'vitest'

import { setDisplayTimeZone } from '@admin/i18n'

import { todayRangeParam } from './api'

afterEach(() => {
  vi.useRealTimers()
  setDisplayTimeZone(null)
})

describe('todayRangeParam', () => {
  it('uses the display-zone calendar date for dashboard drill-down links', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:30:00.000Z'))
    setDisplayTimeZone('America/Los_Angeles')

    expect(todayRangeParam()).toBe('2026-11-19~2026-11-19')
  })
})
