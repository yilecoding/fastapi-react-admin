import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import { describeCron } from './cron-presets'

/**
 * 任务调度。
 *
 * 接口前缀是 **`/api/v1/tasks/schedulers`** —— `app/task` 是和 `app/admin`
 * 平级的独立 app（不是插件），所以不落在 `/sys` 下。
 *
 * ⚠️ id 是雪花字符串，不要 `Number()`（硬纪律 6）。
 */
export type TaskScheduler = {
  id: string
  name: string
  task: string
  /** 0 间隔 · 1 定时（crontab） */
  type: number
  crontab: string
  interval_every: number | null
  interval_period: string | null
  args: string | null
  kwargs: string | null
  queue: string | null
  exchange: string | null
  routing_key: string | null
  start_time: string | null
  expire_time: string | null
  expire_seconds: number | null
  one_off: boolean
  enabled: boolean
  total_run_count: number
  last_run_time: string | null
  remark: string | null
  created_time: string
  updated_time: string | null
}

export type SchedulerListParams = {
  page: number
  size: number
  name?: string
  task?: string
  enabled?: boolean
}

export const schedulerKeys = {
  all: ['task', 'scheduler'] as const,
  list: (p: SchedulerListParams) => [...schedulerKeys.all, 'list', p] as const,
  meta: () => [...schedulerKeys.all, 'meta'] as const,
}

function qs(p: SchedulerListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.name) s.set('name', p.name)
  if (p.task) s.set('task', p.task)
  if (p.enabled !== undefined) s.set('enabled', String(p.enabled))
  return s.toString()
}

export const schedulersQuery = (p: SchedulerListParams) =>
  queryOptions({
    queryKey: schedulerKeys.list(p),
    queryFn: () => api.GET<PageData<TaskScheduler>>(`/api/v1/tasks/schedulers?${qs(p)}`),
    placeholderData: (prev) => prev,
  })

/**
 * 调度运行时元信息：能选哪些任务 + beat 的时区。
 *
 * 🔴 **任务名不能让人手敲。** 打错一个字（`maintenance.prune_log` 少个 s）
 * 就是「调度按时触发、worker 收到一个不认识的名字」—— celery 只记一条
 * `Received unregistered task`，而界面上这条调度的「累计触发次数」照涨，
 * 看起来一切正常。后端保存时也会拦，这个下拉是让人根本不产生那个错。
 */
export type SchedulerMeta = {
  tasks: string[]
  /** beat 解释 crontab 用的时区（IANA）。算执行时间预览必须用它，不能用浏览器时区 */
  timezone: string
}

export const schedulerMetaQuery = () =>
  queryOptions({
    queryKey: schedulerKeys.meta(),
    queryFn: () => api.GET<SchedulerMeta>('/api/v1/tasks/schedulers/meta'),
    // 任务集合和服务端时区都只随发版/部署变，会话内不会变
    staleTime: Infinity,
  })

export type SchedulerBody = {
  name: string
  task: string
  type: number
  crontab?: string
  interval_every?: number | null
  interval_period?: string | null
  args?: string | null
  kwargs?: string | null
  queue?: string | null
  start_time?: string | null
  expire_time?: string | null
  expire_seconds?: number | null
  one_off?: boolean
  enabled?: boolean
  remark?: string | null
}

export function useCreateScheduler() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: SchedulerBody) => api.POST<TaskScheduler>('/api/v1/tasks/schedulers', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  })
}

export function useUpdateScheduler() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SchedulerBody }) =>
      api.PUT(`/api/v1/tasks/schedulers/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  })
}

/**
 * 启用 / 停用。
 *
 * 走独立接口而不是复用 `PUT /{pk}`：后者收整个对象，为了停用一条调度要把
 * crontab、参数、起止时间全带上回传，读漏一个字段就清掉一个
 * （角色 ↔ 用户那条坑同理）。
 */
export function useToggleScheduler() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.PUT(`/api/v1/tasks/schedulers/${id}/status?enabled=${enabled}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  })
}

/** 立即执行一次。返回 celery 的 task_id，可以拿去执行记录页查这一次。 */
export function useRunScheduler() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.POST<string>(`/api/v1/tasks/schedulers/${id}/run`),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  })
}

export function useDeleteSchedulers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (pks: string[]) => api.DELETE('/api/v1/tasks/schedulers', { body: { pks } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: schedulerKeys.all }),
  })
}

// ─── 展示用的枚举映射（值是语言包 key，渲染处过 t()）────────────────────────

/** `backend/app/task/enums.py: TaskSchedulerType` */
export const SCHEDULER_TYPE_LABEL: Record<number, string> = { 0: '间隔', 1: '定时' }
export const SCHEDULER_TYPE_FORM_ITEMS: Record<string, string> = { '1': '定时', '0': '间隔' }
export const SCHEDULER_ENABLED_FILTER_ITEMS: Record<string, string> = {
  all: '全部状态', true: '已启用', false: '已停用',
}

/** `TaskIntervalPeriod` —— 值必须和 `datetime.timedelta` 的关键字一致 */
export const INTERVAL_PERIOD_ITEMS: Record<string, string> = {
  seconds: '秒', minutes: '分钟', hours: '小时', days: '天',
}

/**
 * 把一条调度说成人话，用在列表的「触发策略」列。
 *
 * **混合**：常见的四种形态自己说，其余交给 cronstrue。两边各有各的短板：
 *
 * | 表达式 | 自己写 | cronstrue（zh_CN） |
 * |---|---|---|
 * | `15 3 * * *` | 每天 03:15 | 在03:15 ← **丢了「每天」** |
 * | `0 9,18 * * 1-5` | ❌ 认不出 | 在 09:00 和 18:00, 星期一至星期五 |
 *
 * 单用任何一边都会退步：只用手写的，复杂表达式那一格是空的；
 * 只用 cronstrue，最常见的「每天几点」反而读不出周期。
 * 这个取舍是 E2E 跑出来的 —— 换成纯 cronstrue 之后
 * 「列表说人话」那条断言立刻红了（期望「每天 03:15」，实际「在03:15」）。
 *
 * 解析不了时退回显示原文，不显示空白。
 */
export function describeSchedule(
  s: Pick<TaskScheduler, 'type' | 'crontab' | 'interval_every' | 'interval_period'>,
  t: (k: string, vars?: Record<string, unknown>) => string,
  lang: string
): string {
  if (s.type === 0) {
    return t('每 {{n}} {{unit}}', {
      n: s.interval_every ?? 0,
      unit: t(INTERVAL_PERIOD_ITEMS[s.interval_period ?? 'seconds'] ?? '秒'),
    })
  }

  const expr = s.crontab ?? ''
  const parts = expr.trim().split(/\s+/)
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts
    const plain = (v: string) => /^\d+$/.test(v)
    const at = () => `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
    if (dom === '*' && mon === '*' && dow === '*') {
      if (min === '*' && hour === '*') return t('每分钟')
      if (hour === '*' && plain(min)) return t('每小时第 {{min}} 分', { min })
      if (plain(min) && plain(hour)) return t('每天 {{time}}', { time: at() })
    }
  }

  return describeCron(expr, lang) ?? expr
}
