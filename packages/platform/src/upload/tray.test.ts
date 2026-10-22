import { describe, expect, it } from 'vitest'

import { trayEta, traySummary } from './tray'

const item = (status: string, size = 100, loaded = 0, speed: number | null = null) =>
  ({ status, size, loaded, speed }) as never

describe('traySummary', () => {
  it('按状态分桶，busy = 活跃 + 排队', () => {
    const s = traySummary([item('uploading'), item('queued'), item('done'), item('failed'), item('canceled'), item('hashing')])
    expect(s).toEqual({ total: 6, active: 2, queued: 1, done: 1, failed: 1, canceled: 1, busy: true })
    expect(traySummary([item('done'), item('failed')]).busy).toBe(false)
  })
})

describe('trayEta', () => {
  it('没有在传的 / 没速度 → null', () => {
    expect(trayEta([item('queued')])).toBeNull()
    expect(trayEta([item('uploading', 100, 10, null)])).toBeNull()
    expect(trayEta([item('hashing', 100, 0, 50)])).toBeNull()
  })

  it('当前剩余 + 排队的全部字节，按当前速度算；已完成的不算', () => {
    const eta = trayEta([item('done', 999), item('uploading', 100, 40, 10), item('queued', 30), item('hashing', 20), item('failed', 500)])
    // (60 + 30 + 20) / 10
    expect(eta).toBe(11)
  })
})
