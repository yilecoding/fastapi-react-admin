/**
 * 服务端时间的解析与格式化。
 *
 * ── 为什么需要这一层 ──
 *
 * 后端下发的时间**不是**给人看的字符串，而是一个「瞬间」。原来前端到处
 * 直接把它当字符串打印（`{file.created_time}`）、切片（`.slice(5, 16)`）、
 * 字典序比较（`.localeCompare`），能跑是因为凑巧满足两个前提：
 *   1. 后端下发的是 `'2026-08-22 11:59:47'`（Asia/Shanghai 墙上时间）
 *   2. 看的人也在 Asia/Shanghai
 * 两个前提任意一个不成立，界面上的时间就是错的 —— 而且**不报错**。
 *
 * 现在后端改成下发 ISO 8601（`'2026-08-22T03:59:47Z'`，UTC），
 * 时区在**显示时**才出现。所有服务端时间一律经过本模块，不要再裸打印。
 *
 * ⚠️ 尤其不要再对时间字符串做 `.slice()` —— ISO 串切出来的是 **UTC 的**
 * 年月日，东八区凌晨 8 点之前的记录会被切到前一天。用 `dateKey()`。
 *
 * ── 依赖 ──
 *
 * 只用 `Intl`，零依赖（本包是最底层，不能 import 任何 workspace 包，
 * 也刻意不引 date-fns / dayjs —— `Intl.DateTimeFormat` 的 `timeZone`
 * 选项已经带完整 IANA 时区库，浏览器原生的那份比打包进来的更新更准）。
 */

/**
 * 服务端时间的入参。
 *
 * `string` 是接口下发的（ISO 8601，或过渡期的无时区标记格式，见 `toEpochMs`），
 * `number` / `Date` 是前端自己造的（如 `Date.now()`）。
 * `null` / `undefined` 直接放行 —— 接口里大量字段是可空的
 * （`updated_time` / `last_login_time` / `last_run_time`…），
 * 让调用点不用每处都写 `?? '—'`。
 */
export type ServerTime = string | number | Date | null | undefined

/** 空值/坏值的占位符，与 `formatNumber` 保持一致 */
const EMPTY = '—'

// ─── 时区 ─────────────────────────────────────────────────────────────────────

/**
 * 无时区标记的时间字符串该按哪个时区解释。
 *
 * 这是**过渡期的兜底**：后端已经统一改成下发带 `Z` 的 ISO 8601，但如果有
 * 哪个接口漏改（手写 `timezone.to_str()` 绕过了 pydantic 序列化器的那几处），
 * 下发的就还是 `'2026-08-22 11:59:47'` 这种无时区标记的墙上时间。
 *
 * 有这个兜底，漏改的表现是「时间对的」；没有的话 `new Date()` 会按
 * **浏览器**时区去解释，境外用户看到的时间会整体偏移 —— 静默错，
 * 而且只在非东八区的机器上才复现。
 *
 * 取值跟后端的 `settings.DATETIME_TIMEZONE` 一致。
 */
let legacyTimeZone = 'Asia/Shanghai'

/**
 * 兜底时区，同时也是 `sys_user.timezone` 的默认值。
 *
 * 用在两处：解析不出时区的串按它解释；浏览器老到没有
 * `Intl.supportedValuesOf` 时，时区选择器至少还能列出这一个。
 */
export const BASE_TIME_ZONE = 'Asia/Shanghai'

/**
 * 显示时区。默认跟随浏览器/操作系统。
 *
 * 之所以做成可设置而不是每次读浏览器：将来支持「用户自己选时区」时，
 * 只需要在登录后调一次 `setDisplayTimeZone(me.timezone)`，
 * 全站所有时间显示跟着变，不用改任何调用点。
 */
let displayTimeZone = resolveBrowserTimeZone()

function resolveBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 设置显示时区（IANA 标识，如 `'Asia/Shanghai'`）。传空值则回落到浏览器时区 */
export function setDisplayTimeZone(tz: string | null | undefined): void {
  displayTimeZone = tz || resolveBrowserTimeZone()
}

export function getDisplayTimeZone(): string {
  return displayTimeZone
}

/** 设置「无时区标记字符串」的解释时区，正常不用调，见 `legacyTimeZone` 注释 */
export function setLegacyTimeZone(tz: string): void {
  legacyTimeZone = tz
}

// ─── 解析 ─────────────────────────────────────────────────────────────────────

/**
 * `YYYY-MM-DD[T或空格]HH:mm[:ss[.sss]]`，且**结尾没有**时区标记。
 *
 * 时区标记指 `Z` 或 `±HH:MM` / `±HHMM` / `±HH`。带标记的交给 `new Date()`
 * （它对带标记的 ISO 8601 解析是规范定义的、跨浏览器一致的）；
 * 不带标记的才需要我们自己按 `legacyTimeZone` 解释。
 *
 * 之所以要自己判而不是无脑 `new Date()`：ES 规范对「不带时区标记」的
 * 日期时间串，`T` 分隔的按**本地**时区解释，而空格分隔的根本不在规范里
 * （各浏览器自行发挥，Safari 历史上直接返回 Invalid Date）。
 */
const NAIVE_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/

/**
 * 解析成 epoch 毫秒。**排序、比较、算时间差一律用它**，不要拿字符串比。
 *
 * 解析不出来返回 `null`（而不是 `NaN` 或抛异常）—— 调用点用
 * `?? fallback` 就能处理，不会把 `NaN` 一路带进 UI 变成 `Invalid Date`。
 */
export function toEpochMs(at: ServerTime): number | null {
  if (at === null || at === undefined || at === '') return null

  if (at instanceof Date) {
    const ms = at.getTime()
    return Number.isNaN(ms) ? null : ms
  }

  if (typeof at === 'number') {
    return Number.isFinite(at) ? at : null
  }

  const naive = NAIVE_DATETIME.exec(at.trim())
  if (naive) {
    const [, y, mo, d, h, mi, s] = naive
    return wallClockToEpochMs(
      Number(y),
      Number(mo),
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? 0),
      legacyTimeZone
    )
  }

  const ms = new Date(at).getTime()
  return Number.isNaN(ms) ? null : ms
}

/**
 * 把「某个时区的墙上时间」还原成 epoch 毫秒。
 *
 * 做法：先把这组年月日时分秒**当成 UTC** 得到一个估计值，用它查出该时区在
 * 那一刻的偏移、减掉；再用修正后的瞬间**复核一次**偏移。
 *
 * 复核这一步是为了夏令时边界：估计值落在切换点另一侧时第一次查到的偏移是
 * 错的（差一小时）。当前 `legacyTimeZone` 是 Asia/Shanghai（1991 年后无夏令时）
 * 用不到，但这个函数不该把「恰好没有夏令时」写进假设里。
 */
function wallClockToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const firstPass = asUtc - zoneOffsetMs(asUtc, timeZone)
  return asUtc - zoneOffsetMs(firstPass, timeZone)
}

/**
 * 某个瞬间在某个时区的 UTC 偏移（毫秒，东为正）。
 *
 * 没有直接拿偏移的 API，标准做法是反过来推：把这个瞬间格式化成该时区的
 * 墙上时间，再把这组数字**当成 UTC** 读回来，两者之差就是偏移。
 */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = offsetFormatter(timeZone).formatToParts(new Date(epochMs))
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    return found ? Number(found.value) : 0
  }
  const asUtc = Date.UTC(
    pick('year'),
    pick('month') - 1,
    pick('day'),
    pick('hour'),
    pick('minute'),
    pick('second')
  )
  return asUtc - epochMs
}

// ─── 格式化 ───────────────────────────────────────────────────────────────────

/**
 * `Intl.DateTimeFormat` 构造是**重操作**，而表格一屏能有几百个时间单元格 ——
 * 每格新建一个实例会明显掉帧。按 (用途, 时区) 缓存实例。
 *
 * 时区变了不用手动清：key 里带着时区，换时区自然落到新的实例上。
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function cached(key: string, build: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = formatterCache.get(key)
  if (!f) {
    f = build()
    formatterCache.set(key, f)
  }
  return f
}

/**
 * 推偏移专用的 formatter。
 *
 * `hourCycle: 'h23'` 是必须的：`hour12: false` 在部分实现下会把午夜给成
 * `24`（而不是 `0`），拿去 `Date.UTC` 会算到第二天，偏移直接错一天。
 */
function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  return cached(`offset:${timeZone}`, () =>
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  )
}

/**
 * 取出「在显示时区下」的各时间分量。
 *
 * 用 `formatToParts` 而不是 `format()` 之后再切字符串 —— 后者的输出顺序和
 * 分隔符是 locale 决定的（`en-US` 给 `08/22/2026`），切片必错。
 */
function partsInDisplayZone(epochMs: number): Record<string, string> {
  const parts = cached(`parts:${displayTimeZone}`, () =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: displayTimeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  ).formatToParts(new Date(epochMs))

  const out: Record<string, string> = {}
  for (const p of parts) out[p.type] = p.value
  return out
}

/**
 * 完整日期时间：`2026-08-22 11:59:47`。
 *
 * **固定格式，不跟 locale 走** —— 和 `formatNumber`/`formatDate` 的取向不同，
 * 这是刻意的：它渲染的是日志/审计类机器时间，几乎总在表格里、配
 * `font-mono tabular-nums`。跟 locale 走会得到 `8/22/2026, 11:59:47 AM`，
 * 宽度不定、列对不齐，而且英文 locale 的 `M/D/Y` 对中文用户是歧义的。
 *
 * 散文语境（「创建于 X」）要更自然的写法用 `formatDate` / `formatTime`。
 */
export function formatDateTime(at: ServerTime): string {
  const ms = toEpochMs(at)
  if (ms === null) return EMPTY
  const p = partsInDisplayZone(ms)
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`
}

/**
 * 短日期时间：`08-22 11:59`（省年、省秒）。
 *
 * 给宽度紧张的地方用（仪表盘的近期列表、图表轴）。
 * 这是原来 `.slice(5, 16)` 想做的事 —— 那个切法在 ISO 串上会切出
 * `08-22T03:59`（带个 `T`，而且是 UTC 的日期）。
 */
export function formatDateTimeShort(at: ServerTime): string {
  const ms = toEpochMs(at)
  if (ms === null) return EMPTY
  const p = partsInDisplayZone(ms)
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/**
 * 分组/按天统计用的日期键：`2026-08-22`，**按显示时区算**。
 *
 * 这是原来 `.slice(0, 10)` 想做的事。切 ISO 串拿到的是 **UTC 的**日期：
 * 东八区 8 月 22 日早上 7 点的记录，ISO 是 `2026-08-21T23:00:00Z`，
 * 切出来是 `2026-08-21` —— 按天统计的柱状图会把它算进前一天。
 * 不报错、不空白，只是数字悄悄对不上。
 *
 * 解析不出来返回 `null`，让调用点自己决定是丢掉还是归到「未知」。
 */
export function dateKey(at: ServerTime): string | null {
  const ms = toEpochMs(at)
  if (ms === null) return null
  const p = partsInDisplayZone(ms)
  return `${p.year}-${p.month}-${p.day}`
}
