import { describe, expect, it } from 'vitest'

import { formatDuration } from './cells'

describe('formatDuration', () => {
  it('10ms 以下留一位小数，免得全显示成 0 ms / 1 ms', () => {
    expect(formatDuration(0)).toBe('0.0 ms')
    expect(formatDuration(8.64)).toBe('8.6 ms')
  })
  it('10ms ~ 1s 取整', () => {
    expect(formatDuration(10)).toBe('10 ms')
    expect(formatDuration(52.4)).toBe('52 ms')
    expect(formatDuration(999.4)).toBe('999 ms')
    expect(formatDuration(999.6)).toBe('1.00 s')
  })
  it('1 秒以上换成秒，两位小数', () => {
    expect(formatDuration(1000)).toBe('1.00 s')
    expect(formatDuration(1234)).toBe('1.23 s')
  })
})
