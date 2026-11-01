import { toEpochMs, type ServerTime } from '@admin/i18n'

import type { TFn } from './types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 一段时长的口语说法（「3 小时」「2 天」），只取最大的一级。
 * 差值一律从 `toEpochMs()` 算（i18n 分册：不要 `new Date(str)`）
 */
export function spanText(ms: number, t: TFn): string {
  const v = Math.max(0, ms)
  if (v < HOUR) return t('{{n}} 分钟', { n: Math.max(1, Math.floor(v / MINUTE)) })
  if (v < DAY) return t('{{n}} 小时', { n: Math.floor(v / HOUR) })
  return t('{{n}} 天', { n: Math.floor(v / DAY) })
}

/** 从 `at` 到现在过了多久（毫秒）；解析不出来是 null */
export function since(at: ServerTime): number | null {
  const ms = toEpochMs(at)
  return ms === null ? null : Date.now() - ms
}

/** 现在到 `at` 还有多久（毫秒，已经过了是负数）；解析不出来是 null */
export function until(at: ServerTime): number | null {
  const ms = toEpochMs(at)
  return ms === null ? null : ms - Date.now()
}

export { DAY, HOUR }
