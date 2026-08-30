import { IconClockPlay, IconInfoCircle, IconSpeakerphone } from '@tabler/icons-react'

import { toEpochMs, formatDateTime, type ServerTime } from '@admin/i18n'

import { CATEGORY } from './api'

/** 供 `t()` 用的签名。普通函数不能自己调 hook（i18n 分册第 5 条） */
export type TFn = (key: string, vars?: Record<string, unknown>) => string

export type CategoryMeta = {
  /** 中文原文即 key，渲染处再过 `t()` */
  label: string
  Icon: typeof IconInfoCircle
  /** 图标底色，和 `_shared/status.tsx` 的色板同一套语气 */
  tone: string
}

/**
 * 分类的展示信息。**按数值取**，不是按名字 —— 数值是契约（后端 enum 落库了）。
 *
 * 未知分类要能兜住：后端加了新分类而前端还没更新时，宁可显示一个中性图标，
 * 也不要整条渲染不出来（`CATEGORY_META[x] ?? FALLBACK`）。
 */
export const CATEGORY_META: Record<number, CategoryMeta> = {
  [CATEGORY.SYSTEM]: {
    label: '系统',
    Icon: IconInfoCircle,
    tone: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  },
  [CATEGORY.ANNOUNCEMENT]: {
    label: '公告',
    Icon: IconSpeakerphone,
    tone: 'bg-amber-500/10 text-amber-600 dark:text-amber-500',
  },
  [CATEGORY.TASK]: {
    label: '任务',
    Icon: IconClockPlay,
    tone: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
}

export const CATEGORY_FALLBACK: CategoryMeta = {
  label: '通知',
  Icon: IconInfoCircle,
  tone: 'bg-muted text-muted-foreground',
}

export function categoryMeta(category: number): CategoryMeta {
  return CATEGORY_META[category] ?? CATEGORY_FALLBACK
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 相对时间（「2 分钟前」）。
 *
 * 🔴 差值只能从 `toEpochMs()` 算，不要 `new Date(str)` —— 接口下发的是带偏移的
 * ISO 8601，但过渡期里还可能出现无时区标记的串，那种串 `new Date()` 会按
 * **浏览器**时区解释，境外用户看到的「几分钟前」会整体偏几小时且不报错
 * （见 [i18n 分册](../../../../i18n/AGENTS.md) 的 `toEpochMs`）。
 *
 * 超过一周就退回绝对时间：「37 天前」这种既不好读、也丢掉了确切时刻，
 * 而收件箱翻历史时要的恰恰是确切时刻。
 */
export function relativeTime(at: ServerTime, t: TFn): string {
  const ms = toEpochMs(at)
  if (ms === null) return formatDateTime(at)
  const diff = Date.now() - ms
  // 时钟漂移 / 服务端稍快时 diff 会是负数，别渲染成「-1 分钟前」
  if (diff < MINUTE) return t('刚刚')
  if (diff < HOUR) return t('{{n}} 分钟前', { n: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('{{n}} 小时前', { n: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return t('{{n}} 天前', { n: Math.floor(diff / DAY) })
  return formatDateTime(at)
}
