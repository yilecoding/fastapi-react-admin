import { queryOptions } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import { presetRange } from '@admin/ui/components/datetime-picker'

/**
 * 仪表盘的数据源。
 *
 * ⚠️ **后端没有任何聚合/统计接口** —— 这里全部指标都是拿现有列表接口的
 * `total` 字段算出来的：请求 `size=1` 只为了拿分页元数据里的总数，
 * 不是真的要那一条记录。这样零后端改动，代价是每个指标一个请求。
 *
 * 真要做重的统计（按天分组、留存、漏斗）必须先给后端加聚合端点，
 * 前端这样拼是拼不出来的 —— 别在这一页上加需要 GROUP BY 的东西。
 */

/** 拿分页总数：size=1 是为了让后端少序列化，不是要那条数据 */
async function countOf(path: string, params: Record<string, string | undefined>): Promise<number> {
  const q = new URLSearchParams({ page: '1', size: '1' })
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v)
  const data = await api.GET<PageData<unknown>>(`${path}?${q.toString()}`)
  return data.total ?? 0
}

export const dashKeys = {
  all: ['dashboard'] as const,
  today: () => [...dashKeys.all, 'today'] as const,
  trend: () => [...dashKeys.all, 'trend'] as const,
  recent: (kind: string) => [...dashKeys.all, 'recent', kind] as const,
  online: () => [...dashKeys.all, 'online'] as const,
  scale: () => [...dashKeys.all, 'scale'] as const,
}

export type TodayStats = {
  logins: number
  loginFails: number
  operations: number
  operaFails: number
}

/**
 * 今日概览。
 *
 * 「今日」的边界用 `presetRange('today')` 算 —— 与日志页筛选栏用的是同一套，
 * 所以点「今日登录」跳过去时，日志页的筛选条件和这里的口径完全一致，
 * 不会出现「卡片说 12 条、点进去只有 9 条」这种对不上。
 */
export const todayStatsQuery = queryOptions({
  queryKey: dashKeys.today(),
  queryFn: async (): Promise<TodayStats> => {
    // 带时分秒：接口收的是 datetime，`end_time` 只给日期会被解析成当天 00:00:00，
    // 静默丢掉今天一整天（见 query-bar/params.ts 里那段）
    const [start, end] = presetRange('today', true)
    const [logins, loginFails, operations, operaFails] = await Promise.all([
      countOf('/api/v1/logs/login', { start_time: start, end_time: end }),
      countOf('/api/v1/logs/login', { start_time: start, end_time: end, status: '0' }),
      countOf('/api/v1/logs/opera', { start_time: start, end_time: end }),
      countOf('/api/v1/logs/opera', { start_time: start, end_time: end, status: '0' }),
    ])
    return { logins, loginFails, operations, operaFails }
  },
  staleTime: 30_000,
})

export type ScaleStats = { users: number; roles: number; notices: number }

/** 平台规模。变化很慢，缓存久一点。 */
export const scaleStatsQuery = queryOptions({
  queryKey: dashKeys.scale(),
  queryFn: async (): Promise<ScaleStats> => {
    const [users, roles, notices] = await Promise.all([
      countOf('/api/v1/sys/users', {}),
      countOf('/api/v1/sys/roles', {}),
      countOf('/api/v1/sys/notices', {}),
    ])
    return { users, roles, notices }
  },
  staleTime: 5 * 60_000,
})

/**
 * 在线会话数。
 *
 * ⚠️ `/monitors/sessions` 是 `DependsSuperUser`，非超管会 403。
 * 调用方要按「没权限」而不是「出错」来展示 —— 见 index.tsx 里的 `enabled` 判断。
 * 这个接口不分页，一次扫完 Redis 的 `fba:token:*` 全给。
 */
export const onlineCountQuery = queryOptions({
  queryKey: dashKeys.online(),
  queryFn: async (): Promise<number> => {
    const list = await api.GET<unknown[]>('/api/v1/monitors/sessions')
    return Array.isArray(list) ? list.length : 0
  },
  staleTime: 20_000,
  retry: false,
})

/**
 * 近 7 天每日登录数。
 *
 * 成本说明（重要）：后端**没有按天分组的能力**，所以：
 * - 每日**总数**只能一天一个请求（7 个并发的 `size=1`，很轻）
 * - 每日**失败数**换个打法 —— 失败是稀疏事件，整段区间**取一次明细**
 *   再在前端按天分桶，1 个请求顶 7 个
 *
 * 这样趋势图从 14 个请求降到 8 个。
 * **不要**照这个思路扩到 30/90 天：那是 30/90 个请求，该给后端加聚合端点了。
 *
 * ⚠️ 失败明细有 `FAIL_SAMPLE_CAP` 上限。超出时 `truncated` 会置位，
 * 页面必须把「只统计了最近 N 条」说出来 —— 静默少算比不显示更糟。
 */
export type DayPoint = { date: string; label: string; total: number; fails: number }
export type TrendResult = { points: DayPoint[]; truncated: boolean; failTotal: number }

/**
 * 失败明细的取样上限。
 *
 * ⚠️ 后端分页的 `size` **硬上限是 200**（`common/pagination.py`），
 * 超了直接 422 —— 实测写 300 会让整个趋势 query 挂掉，连日总数一起丢，
 * 图上一根柱子都没有。这个数不能再往上调。
 */
const FAIL_SAMPLE_CAP = 200

export const loginTrendQuery = queryOptions({
  queryKey: dashKeys.trend(),
  queryFn: async (): Promise<TrendResult> => {
    const p = (n: number) => String(n).padStart(2, '0')
    const days: Array<{ date: string; label: string; start: string; end: string }> = []
    const now = new Date()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
      const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
      days.push({
        date,
        label: `${p(d.getMonth() + 1)}-${p(d.getDate())}`,
        start: `${date} 00:00:00`,
        end: `${date} 23:59:59`,
      })
    }
    const windowStart = days[0]!.start
    const windowEnd = days[days.length - 1]!.end

    const [totals, failPage] = await Promise.all([
      Promise.all(
        days.map((d) => countOf('/api/v1/logs/login', { start_time: d.start, end_time: d.end }))
      ),
      api.GET<PageData<{ login_time: string }>>(
        `/api/v1/logs/login?page=1&size=${FAIL_SAMPLE_CAP}` +
          `&status=0&start_time=${encodeURIComponent(windowStart)}&end_time=${encodeURIComponent(windowEnd)}`
      ),
    ])

    // 后端下发的时间是 'YYYY-MM-DD HH:mm:ss'，取前 10 位就是日期键
    const failByDay = new Map<string, number>()
    for (const item of failPage.items ?? []) {
      const key = (item.login_time ?? '').slice(0, 10)
      failByDay.set(key, (failByDay.get(key) ?? 0) + 1)
    }

    const failTotal = failPage.total ?? 0
    return {
      points: days.map((d, i) => ({
        date: d.date,
        label: d.label,
        total: totals[i] ?? 0,
        fails: failByDay.get(d.date) ?? 0,
      })),
      truncated: failTotal > FAIL_SAMPLE_CAP,
      failTotal,
    }
  },
  staleTime: 5 * 60_000,
})

// ─── 最近动态 ────────────────────────────────────────────────────────────────

export type RecentLogin = {
  id: string
  username: string
  status: number
  ip: string
  login_time: string
  msg: string
}

export type RecentOpera = {
  id: string
  username: string | null
  /** 操作摘要，字段名是 `title` 不是 summary */
  title: string
  method: string
  path: string
  status: number
  code: string
  cost_time: number
  opera_time: string
}

const RECENT_SIZE = 6

export const recentLoginsQuery = queryOptions({
  queryKey: dashKeys.recent('login'),
  queryFn: () =>
    api
      .GET<PageData<RecentLogin>>(`/api/v1/logs/login?page=1&size=${RECENT_SIZE}`)
      .then((d) => d.items ?? []),
  staleTime: 30_000,
})

export const recentOperasQuery = queryOptions({
  queryKey: dashKeys.recent('opera'),
  queryFn: () =>
    api
      .GET<PageData<RecentOpera>>(`/api/v1/logs/opera?page=1&size=${RECENT_SIZE}`)
      .then((d) => d.items ?? []),
  staleTime: 30_000,
})

/**
 * 「今天」在**日志页地址栏**里的写法，给卡片上的下钻链接用。
 *
 * 日志页的时间筛选在 URL 里是一个参数（`time=起~止`，整天边界不写时分秒），
 * 接口那两个 `start_time` / `end_time` 由查询区在发请求时拼 ——
 * 所以跳过去只能给这一份，不能给 `presetRange()` 的完整串。
 * 口径仍然是同一个 `presetRange('today')`，卡片数字和点进去的列表不会对不上。
 */
export function todayRangeParam(): string {
  const [start, end] = presetRange('today')
  return `${start ?? ''}~${end ?? ''}`
}
