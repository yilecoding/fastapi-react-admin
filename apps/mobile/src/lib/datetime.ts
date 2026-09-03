import { dateKey, t, toEpochMs } from '@admin/i18n'

/**
 * 相对时间 —— 只有「相对」这一段是移动端自己的，**解析和日期格式化用共享那份**。
 *
 * 🔴 **不要自己 `new Date(iso)` 解析。** 后端下发的时间戳有两种形态
 * （实测同一个接口里就混着 `…Z` 和 `…+08:00`），而 ES 规范对**不带时区标记**
 * 的串是按本地时区解释、空格分隔的那种规范里压根没定义。
 * `@admin/i18n` 的 `toEpochMs()` 把这三种情况都摊开了（那边还记着为什么），
 * 抄一份只会漏掉其中一两种，而漏掉的表现是**时间差了 8 小时**、不报错。
 *
 * 🔴 **超过 30 天的兜底日期要按「显示时区」算，不是设备时区。**
 * 「显示时区」是账号级设置，`session.tsx` 拿到 `/me` 时喂给了那个层。
 * 这里原来用 `d.getFullYear()/getMonth()/getDate()` —— 那读的是**设备**时区，
 * 于是用户在设置里选了纽约、列表里的日期还是按手机时区显示，
 * 而且跨日的那几个小时会差一天。`dateKey()` 是按显示时区取的。
 *
 * ⚠️ 仍然**不用 `Intl.RelativeTimeFormat`** —— Hermes 的 Platform Intl 只实现了
 * `Collator` / `DateTimeFormat` / `NumberFormat`，`RelativeTimeFormat` 不在里面，
 * 缺了是静默回落。`DateTimeFormat`（`dateKey` 用的那个）是安全的：
 * RN 的 Hermes 在两端都硬编译了 `-DHERMES_ENABLE_INTL=True`
 * （`ReactAndroid/hermes-engine/build.gradle.kts:358` 那里的注释是
 * "We intentionally build Hermes with Intl support only"）。
 */
export function relativeTime(iso: string): string {
  // ⚠️ 这个局部变量原来叫 `t`，把导入的 `t()` 遮住了 —— 正是 `i18n:check`
  // 里 `shadowed-t` 那条规则要抓的东西（tsc 也会报 `Type 'Number' has no
  // call signatures`，算是响亮）。凡是这个文件里要用 `t()`，局部就别叫 t。
  const ms = toEpochMs(iso)
  if (ms === null) return ''
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('刚刚')
  if (min < 60) return t('{{n}} 分钟前', { n: min })
  const hour = Math.floor(min / 60)
  if (hour < 24) return t('{{n}} 小时前', { n: hour })
  const day = Math.floor(hour / 24)
  if (day < 30) return t('{{n}} 天前', { n: day })
  return dateKey(iso) ?? ''
}
