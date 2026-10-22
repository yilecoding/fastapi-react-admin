import { isActive } from './queue'
import type { UploadItem } from './types'

export interface TraySummary {
  total: number
  active: number
  queued: number
  done: number
  failed: number
  canceled: number
  /** 还有在传 / 在排队的 */
  busy: boolean
}

export function traySummary(items: readonly Pick<UploadItem, 'status'>[]): TraySummary {
  const s: TraySummary = { total: items.length, active: 0, queued: 0, done: 0, failed: 0, canceled: 0, busy: false }
  for (const it of items) {
    if (it.status === 'queued') s.queued++
    else if (isActive(it)) s.active++
    else if (it.status === 'done') s.done++
    else if (it.status === 'failed') s.failed++
    else if (it.status === 'canceled') s.canceled++
  }
  s.busy = s.active + s.queued > 0
  return s
}

/**
 * 整个队列的剩余秒数：当前这一项剩下的 + 排队的全部字节，除以当前速度。
 * 串行上传所以好算；还没有速度（刚开始 / 在算校验和）时返回 null，浮窗显示「正在计算…」
 */
export function trayEta(items: readonly Pick<UploadItem, 'status' | 'size' | 'loaded' | 'speed'>[]): number | null {
  const current = items.find((it) => it.status === 'uploading')
  if (!current || current.speed === null || current.speed <= 0) return null
  let remaining = current.size - current.loaded
  for (const it of items) {
    if (it.status === 'queued' || it.status === 'hashing' || it.status === 'checking') remaining += it.size
  }
  return Math.max(0, Math.ceil(remaining / current.speed))
}
