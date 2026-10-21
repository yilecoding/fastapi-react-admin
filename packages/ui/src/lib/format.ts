/**
 * 字节数 / 速度 / 剩余时间的人话格式。`ui` 不能 import `platform`，所以这里自己有一份
 * （`platform/pages/file/api.ts` 的 `formatBytes` 同一个算法）。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`
}

export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

/** 剩余秒数 → `12s` / `1m 05s`；算不出来返回空串 */
export function formatEta(remainingBytes: number, bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || bytesPerSecond <= 0 || remainingBytes <= 0) return ''
  const seconds = Math.ceil(remainingBytes / bytesPerSecond)
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${String(s).padStart(2, '0')}s`
}
