import { CronExpressionParser } from 'cron-parser'
import cronstrue from 'cronstrue/i18n'

/**
 * Cron 的预设、翻译与执行时间预览。
 *
 * 🔴 **只用 Unix 5 段 cron（分 时 日 月 周），不是 Quartz。**
 * celery 用的是 5 段；Quartz 那套（7 段、`?`、`L`、`W`、`#`）它一个都不认。
 * 实测：
 *
 *     ✅ 0 8 * * 1        每周一 08:00
 *     ❌ 0 0 0 * * ? *    只接受 5 段，收到 7 段
 *     ❌ 0 0 * * ?        Invalid weekday literal '?'
 *     ❌ 0 0 L * *        Invalid weekday literal 'L'
 *
 * 所以「每月最后一天」这类预设**不能提供** —— Unix cron 表达不了它。
 * 给一个 `0 0 28-31 * *` 的近似值，等于把界面上的承诺偷偷换成另一回事。
 */

/** 值是语言包 key（中文原文即 key），渲染处过 `t()` */
export const CRON_PRESETS: readonly { expr: string; label: string }[] = [
  { expr: '* * * * *', label: '每分钟' },
  { expr: '*/5 * * * *', label: '每 5 分钟' },
  { expr: '*/30 * * * *', label: '每 30 分钟' },
  { expr: '0 * * * *', label: '每小时整点' },
  { expr: '0 8 * * *', label: '每天早上 8 点' },
  { expr: '15 3 * * *', label: '每天凌晨 3:15' },
  { expr: '0 8 * * 1', label: '每周一早上 8 点' },
  { expr: '0 9 * * 1-5', label: '工作日早上 9 点' },
  { expr: '0 0 1 * *', label: '每月 1 日零点' },
]


/** Quartz 独有、Unix cron 不认的记号 */
const QUARTZ_TOKENS = /[?LW#]/i

/**
 * 🔴 这道闸门不能省，**两个库都比 celery 宽松**。实测：
 *
 * | 表达式 | cronstrue | cron-parser | celery |
 * |---|---|---|---|
 * | `0 0 * * ?` | 在00:00 | 2026/8/23 00:00 | ❌ Invalid weekday literal '?' |
 * | `0 0 L * *` | 在00:00, 限每月的最后一天 | 2026/8/31 00:00 | ❌ Invalid weekday literal 'L' |
 * | `0 0 * * 1#2` | 限每月的第二个 星期一 | 2026/9/14 00:00 | ❌ |
 *
 * 也就是说：不挡的话，一个 celery 根本跑不了的表达式会在界面上得到
 * 一句像模像样的中文说明和五个具体时间 —— **预览给坏表达式打了包票**，
 * 这比没有预览更糟。后端 schema 会拒（存不进去），但那要等到点保存。
 *
 * 口径和后端 `schema/scheduler.py` 保持一致：5 段 + 无 Quartz 记号。
 */
export function isCeleryCron(expr: string): boolean {
  const parts = (expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) return false
  return !QUARTZ_TOKENS.test(expr)
}

/**
 * 表达式 → 人话。
 *
 * 用 cronstrue 而不是自己写：手写只能认出「每天/每小时」那几种固定形态，
 * 遇到 `0 9,18 * * 1-5`（工作日早晚各一次）就哑了，而列表里那一列
 * 恰恰是给人确认「是不是按我想的时间跑」用的。
 */
export function describeCron(expr: string, lang: string): string | null {
  if (!isCeleryCron(expr)) return null
  try {
    return cronstrue.toString(expr, {
      locale: lang === 'zh-CN' ? 'zh_CN' : 'en',
      use24HourTimeFormat: lang === 'zh-CN',
      throwExceptionOnParseError: true,
    })
  } catch {
    return null
  }
}

/**
 * 接下来 N 次会在什么时候跑。
 *
 * 🔴 **`tz` 必须传 beat 的时区**（`/tasks/schedulers/meta` 下发的那个），
 * 不能用浏览器时区。beat 按服务端时区解释 crontab —— 两边不同时，
 * 用浏览器时区算出来的预览看着像模像样，实际和真正触发的时刻差好几个小时，
 * 而这个预览存在的全部意义就是让人确认「是不是按我想的时间跑」。
 *
 * 返回的是**绝对时刻**（Date），渲染时再按观看者的显示时区格式化 ——
 * 那一步交给 `@admin/i18n` 的 `formatDateTime`。
 */
export function nextRuns(expr: string, tz: string, count = 5): Date[] {
  if (!isCeleryCron(expr)) return []
  try {
    const it = CronExpressionParser.parse(expr, { tz })
    return Array.from({ length: count }, () => it.next().toDate())
  } catch {
    return []
  }
}
