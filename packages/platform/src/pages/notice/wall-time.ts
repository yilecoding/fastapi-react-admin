import { formatDateTime, type ServerTime } from '@admin/i18n'

/**
 * 日期时间选择器的值（`YYYY-MM-DD HH:mm:ss` 墙上时间）↔ 接口要的带偏移 ISO，**按显示时区**。
 *
 * 为什么不照 `open-app/form.tsx` 那样 `new Date(local)`：那是按**浏览器**时区解释的，
 * 而列表、详情里的时间都按显示时区（`sys_user.timezone`，i18n 分册）印 ——
 * 两者不一样时，填「18:00 过期」存进去的是另一个钟点，回显也对不上，而且不报错。
 *
 * 只借 `formatDateTime`（显示时区）反推偏移，不另起一套时区计算：纯函数，没有 React。
 */

const WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** 墙上时间当成 UTC 读成毫秒 —— 只用来推偏移 */
function wallAsUtc(wall: string): number | null {
  const m = WALL.exec(wall)
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!)
}

/** 服务端时间 → 选择器的值（显示时区的墙上时间）。空值给 `undefined` = 选择器显示占位符 */
export function toWallTime(at: ServerTime): string | undefined {
  if (at === null || at === undefined || at === '') return undefined
  const s = formatDateTime(at)
  return WALL.test(s) ? s : undefined
}

/**
 * 选择器的值 → 带偏移的 ISO（UTC）。空 / 形状不对给 `null` = 不过期。
 *
 * 先把墙上时间当 UTC 得到估计值，看它在显示时区印出来差多少、减掉；再用修正后的瞬间
 * **复核一次**偏移 —— 估计值落在夏令时切换点另一侧时，第一次查到的偏移差一小时
 * （同 `i18n/datetime.ts: wallClockToEpochMs` 的两步法）。
 */
export function wallTimeToIso(wall: string | undefined): string | null {
  if (!wall) return null
  const asUtc = wallAsUtc(wall)
  if (asUtc === null) return null
  const offsetAt = (ms: number) => (wallAsUtc(formatDateTime(ms)) ?? ms) - ms
  const first = asUtc - offsetAt(asUtc)
  return new Date(asUtc - offsetAt(first)).toISOString()
}
