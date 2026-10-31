import { queryOptions } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import { dateKey } from '@admin/i18n'
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
  today: (kind: 'login' | 'opera') => [...dashKeys.all, 'today', kind] as const,
  trend: () => [...dashKeys.all, 'trend'] as const,
  recent: (kind: string) => [...dashKeys.all, 'recent', kind] as const,
  online: () => [...dashKeys.all, 'online'] as const,
  count: (kind: 'users' | 'roles' | 'notices') => [...dashKeys.all, 'count', kind] as const,
}

/** 今日的一类日志：总数 + 失败数 */
export type TodayCount = { total: number; fails: number }

/**
 * 今日登录 / 今日操作。
 *
 * 🔴 **两类日志各一个查询**（#202 之前是一个 `Promise.all` 一起取）：两个接口要的权限码不同
 * （`log:login:list` / `log:opera:list`），绑在一起的话只有其中一个权限的人整张指标卡一起 403。
 * 卡片按权限决定发不发哪一个（`enabled`），没权限的那一格不画。
 *
 * 「今日」的边界用 `presetRange('today')` 算 —— 与日志页筛选栏用的是同一套，
 * 所以点「今日登录」跳过去时，日志页的筛选条件和这里的口径完全一致，
 * 不会出现「卡片说 12 条、点进去只有 9 条」这种对不上。
 */
export const todayCountQuery = (kind: 'login' | 'opera') =>
  queryOptions({
    queryKey: dashKeys.today(kind),
    queryFn: async (): Promise<TodayCount> => {
      // 带时分秒：接口收的是 datetime，`end_time` 只给日期会被解析成当天 00:00:00，
      // 静默丢掉今天一整天（见 query-bar/params.ts 里那段）
      const [start, end] = presetRange('today', true)
      const path = `/api/v1/logs/${kind}`
      const [total, fails] = await Promise.all([
        countOf(path, { start_time: start, end_time: end }),
        countOf(path, { start_time: start, end_time: end, status: '0' }),
      ])
      return { total, fails }
    },
    staleTime: 30_000,
  })

/**
 * 平台规模（用户数 / 角色数 / 公告数）。变化很慢，缓存久一点。同样按权限拆成三个查询：
 * 用户 `sys:user:list`、角色 `sys:role:list`，公告走读者那个口（`/feed`：显示中、没过期的，只要登录）。
 * 原来数的是管理端的 `/sys/notices`，把隐藏的、「通知」类型的都算进去了；而那个口现在要 `sys:notice:add`（#186）。
 */
const COUNT_PATH = {
  users: '/api/v1/sys/users',
  roles: '/api/v1/sys/roles',
  notices: '/api/v1/sys/notices/feed',
} as const

export const scaleCountQuery = (kind: keyof typeof COUNT_PATH) =>
  queryOptions({
    queryKey: dashKeys.count(kind),
    queryFn: () => countOf(COUNT_PATH[kind], {}),
    staleTime: 5 * 60_000,
  })

/**
 * 在线会话数。
 *
 * ⚠️ `/monitors/sessions` 是 `DependsSuperUser`，非超管会 403。
 * 非超管不发这个请求（`enabled`），那一格也不画 —— 见 `cards/stats.tsx`。
 * 这个接口不分页，一次读完后端的会话索引全给（#138）。
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
    // 「哪一天」一律按**显示时区**算，和下面 `dateKey()` 的分组键同一个时区框架。
    //
    // 原来这里用 `new Date().getFullYear()/getMonth()/getDate()` —— 那是**浏览器**
    // 时区的今天，而分组键是切后端字符串得到的**服务端**时区的日期。两者只在
    // 「浏览器和服务端都在东八区」时才吻合，不吻合时柱子会整体错位一天。
    const days: Array<{ date: string; label: string; start: string; end: string }> = []
    const todayKey = dateKey(Date.now()) ?? new Date().toISOString().slice(0, 10)
    const [ty, tm, td] = todayKey.split('-').map(Number)
    for (let i = 6; i >= 0; i--) {
      // 纯日历算术：UTC 只是个不带夏令时的载体，跟展示时区无关
      const date = new Date(Date.UTC(ty!, tm! - 1, td! - i)).toISOString().slice(0, 10)
      days.push({
        date,
        label: date.slice(5),
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

    // 🔴 **不要**切字符串取日期键。后端现在下发的是带时区偏移的 ISO 8601，
    // `.slice(0, 10)` 拿到的是 **UTC 的**年月日：东八区 8 月 22 日早上 7 点的
    // 登录，ISO 是 `2026-08-21T23:00:00+00:00`，切出来是 8 月 21 日 ——
    // 柱状图把它算进前一天，不报错、不空白，只是数字悄悄对不上。
    const failByDay = new Map<string, number>()
    for (const item of failPage.items ?? []) {
      const key = dateKey(item.login_time)
      if (key) failByDay.set(key, (failByDay.get(key) ?? 0) + 1)
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
