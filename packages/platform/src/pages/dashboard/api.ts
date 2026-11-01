import { queryOptions } from '@tanstack/react-query'

import { getDisplayTimeZone } from '@admin/i18n'
import { presetRange } from '@admin/ui/components/datetime-picker'

import { api, type PageData } from '../../api-client/client'
import { workflowKeys, type InstanceRow } from '../workflow/api'

/**
 * 工作台的数据源（#202）。
 *
 * - 「待我处理」「我发起的」走审批插件的列表接口，带工作台专用的参数（`sort=attention` / `progress=true`）
 * - 「系统运行」三块走 `/sys/dashboard/*`：每块一个接口，一块挂了只影响那一张卡片
 *
 * query key 都挂在 `dashKeys.all`（`['dashboard']`）或审批的 `workflowKeys.all` 下 ——
 * 「刷新」按这两个前缀失效；日志页「清空」那里失效 `['dashboard']`，访问柱状图跟着重取。
 */

const WF = '/api/v1/sys/workflow'

export const dashKeys = {
  all: ['dashboard'] as const,
  system: () => [...dashKeys.all, 'system'] as const,
  attention: () => [...dashKeys.system(), 'attention'] as const,
  services: () => [...dashKeys.system(), 'services'] as const,
  visits: (days: number, tz: string) => [...dashKeys.system(), 'visits', days, tz] as const,
}

// ── 待我处理 ─────────────────────────────────────────────────────────────────

export type TimeoutAction = 'remind' | 'approve' | 'reject'

/** 待办一行（审批中心那份 `InstanceRow` + 工作台要的几项） */
export type DeskTodoRow = InstanceRow & {
  task_id: string
  arrived_time: string
  urgent: boolean
  /** 节点配了超时：什么时候到点 / 到点做什么 */
  due_time: string | null
  timeout_action: TimeoutAction | null
  /** 退回给发起人（开始节点上的待办）：「改完重新提交」 */
  back: boolean
  back_by: string | null
  back_reason: string | null
  /** 转交过来的：原来在谁手上 */
  transferred_from: string | null
  initiator_dept: string | null
}

/** 工作台一次取多少条待办（加急 → 快到期 → 到手时间排好的前 N 条，标题里的「几件 / 其中几件加急」也从这里数） */
export const DESK_TODO_SIZE = 50

export const deskTodoQuery = queryOptions({
  queryKey: [...workflowKeys.inbox(), 'desk'] as const,
  queryFn: () => api.GET<PageData<DeskTodoRow>>(`${WF}/inbox/todo?page=1&size=${DESK_TODO_SIZE}&sort=attention`),
})

export type DeskDraft = { code: string; name: string | null; summary: string | null; updated_time: string }

export const deskDraftsQuery = queryOptions({
  // 和审批中心的 `draftsQuery` 同一个 key：在发起页存了草稿，这里跟着变
  queryKey: [...workflowKeys.all, 'drafts'] as const,
  queryFn: () => api.GET<DeskDraft[]>(`${WF}/drafts`),
})

// ── 我发起的 ─────────────────────────────────────────────────────────────────

export type StepState = 'done' | 'current' | 'rejected'

export type InitiatedRow = InstanceRow & {
  current_node_name: string | null
  handlers: string[]
  /** 当前这一步到办理人手上的时间（「已等多久」） */
  arrived_time: string | null
  back: boolean
  back_by: string | null
  back_reason: string | null
  /** 被退回时选了「直接回到我这一步」：重新提交之后直接回到哪一步 */
  resume_to: string | null
  /** 这一轮走过的步骤（不含「发起」） */
  steps: { name: string; state: StepState }[]
  /** 推演出来的后面步骤；`null` = 推演不了（条件用到了看不到的字段），前端画「后面还有」不编 */
  next_steps: string[] | null
  last: { action: string; actor_name: string | null; opinion: string | null; time: string } | null
}

export const INITIATED_SIZE = 3

export const deskInitiatedQuery = queryOptions({
  queryKey: [...workflowKeys.inbox(), 'desk-initiated'] as const,
  queryFn: () =>
    api.GET<PageData<InitiatedRow>>(`${WF}/inbox/initiated?page=1&size=${INITIATED_SIZE}&progress=true`),
})

// ── 快速发起 ─────────────────────────────────────────────────────────────────

export type StartableDef = {
  id: string
  code: string
  name: string
  icon: string | null
  category: string | null
  sort: number
  /** 这个人近 90 天发起过几张 */
  my_recent_count: number
}

export const deskStartableQuery = queryOptions({
  queryKey: [...workflowKeys.startable(), 'desk'] as const,
  queryFn: () => api.GET<StartableDef[]>(`${WF}/startable`),
  staleTime: 5 * 60_000,
})

// ── 系统运行 ─────────────────────────────────────────────────────────────────

export type AttentionItem =
  | {
      kind: 'webhook_disabled'
      level: 'critical' | 'warning'
      name: string
      app_id: string
      time: string | null
      failures: number
      last_delivery_time: string | null
    }
  | {
      kind: 'task_failed'
      level: 'critical' | 'warning'
      task: string
      name: string
      count: number
      time: string | null
      error: string | null
    }
  | {
      kind: 'login_fail_spike'
      level: 'critical' | 'warning'
      count: number
      avg: number
      top_ip: string | null
      top_ip_count: number
    }

export const attentionQuery = queryOptions({
  queryKey: dashKeys.attention(),
  queryFn: () => api.GET<AttentionItem[]>('/api/v1/sys/dashboard/attention'),
})

export type ServiceState = { status: 'ok' | 'error' | 'stale' | 'missing' | 'unknown'; last_seen_seconds?: number | null }

export type ServicesStatus = {
  status: 'ok' | 'degraded'
  services: Record<'api' | 'database' | 'redis' | 'scheduler' | 'worker', ServiceState>
  heartbeat_max_age_seconds: number
  /** 会话索引读不到（Redis 挂了）时是 `null` —— 「不知道」，不是 0 */
  sessions: { total: number; web: number; desktop: number; mobile: number } | null
}

export const servicesQuery = queryOptions({
  queryKey: dashKeys.services(),
  queryFn: () => api.GET<ServicesStatus>('/api/v1/sys/dashboard/services'),
  staleTime: 20_000,
})

export type VisitPoint = { date: string; total: number; fails: number }

export const VISIT_DAYS = 14

/**
 * 近 14 天每天登录成功 / 失败。「哪一天」按**显示时区**切（后端按 `tz` 算边界）：
 * 按服务端时区切的话，查看人和服务端不在一个时区时柱子整体错一天
 */
export const visitsQuery = () => {
  const tz = getDisplayTimeZone()
  return queryOptions({
    queryKey: dashKeys.visits(VISIT_DAYS, tz),
    queryFn: () =>
      api.GET<{ tz: string; points: VisitPoint[] }>(
        `/api/v1/sys/dashboard/visits?days=${VISIT_DAYS}&tz=${encodeURIComponent(tz)}`
      ),
    staleTime: 5 * 60_000,
  })
}

/**
 * 「今天」在**日志页地址栏**里的写法，给「看明细」那种下钻链接用。
 *
 * 日志页的时间筛选在 URL 里是一个参数（`time=起~止`，整天边界不写时分秒），
 * 接口那两个 `start_time` / `end_time` 由查询区在发请求时拼 —— 所以跳过去只能给这一份。
 * 口径是日志页筛选栏同一个 `presetRange('today')`
 */
export function todayRangeParam(): string {
  const [start, end] = presetRange('today')
  return `${start ?? ''}~${end ?? ''}`
}
