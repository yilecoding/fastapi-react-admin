import { describe, expect, it } from 'vitest'

import { formatMs } from './cells'

describe('formatMs', () => {
  it('10ms 以下留一位小数，免得全显示成 0 ms / 1 ms', () => {
    expect(formatMs(0)).toBe('0.0 ms')
    expect(formatMs(8.64)).toBe('8.6 ms')
    expect(formatMs(9.96)).toBe('10 ms') // 不能是「10.0 ms」
  })
  it('10ms ~ 1s 取整', () => {
    expect(formatMs(10)).toBe('10 ms')
    expect(formatMs(52.4)).toBe('52 ms')
    expect(formatMs(999.4)).toBe('999 ms')
    expect(formatMs(999.6)).toBe('1.00 s')
  })
  it('1 秒以上换成秒，两位小数', () => {
    expect(formatMs(1000)).toBe('1.00 s')
    expect(formatMs(1234)).toBe('1.23 s')
  })
})
