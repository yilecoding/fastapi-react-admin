/**
 * 相对时间。
 *
 * ⚠️ 后端下发的时间戳有两种形态（实测同一个接口里就混着）：
 *   `2026-08-30T08:57:46.583333Z`         —— 带 Z 的 UTC
 *   `2026-08-30T17:06:52.204404+08:00`    —— 带偏移量
 * 两种 `new Date()` 都吃得下，**但不带时区标记的那种不行**（会被当本地时间）。
 * 现在后端两种都带，所以直接解析；哪天出现裸时间戳，这里要先补 'Z'。
 *
 * 不用 `Intl.RelativeTimeFormat`：Hermes 的 Intl 支持视构建而定，
 * 缺了是**静默回落**（输出英文或抛错），而这点逻辑自己写只有十行。
 */
export function relativeTime(iso: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
