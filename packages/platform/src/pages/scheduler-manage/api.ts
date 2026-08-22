import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

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
  registered: () => [...schedulerKeys.all, 'registered'] as const,
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
 * 已注册的 Celery 任务，给表单的「任务」下拉用。
 *
 * 🔴 **任务名不能让人手敲。** 打错一个字（`maintenance.prune_log` 少个 s）
 * 就是「调度按时触发、worker 收到一个不认识的名字」—— celery 只记一条
 * `Received unregistered task`，而界面上这条调度的「累计触发次数」照涨，
 * 看起来一切正常。后端保存时也会拦，这个下拉是让人根本不产生那个错。
 */
export const registeredTasksQuery = () =>
  queryOptions({
    queryKey: schedulerKeys.registered(),
    queryFn: () => api.GET<string[]>('/api/v1/tasks/schedulers/registered'),
    // 任务集合只随发版变，会话内不会变
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
 * 不直接显示 `crontab` 原文：`15 3 * * *` 对大多数人不是可读的，
 * 而这一列的作用就是让人一眼确认「它是不是按我想的时间跑」。
 */
export function describeSchedule(
  s: Pick<TaskScheduler, 'type' | 'crontab' | 'interval_every' | 'interval_period'>,
  t: (k: string, vars?: Record<string, unknown>) => string
): string {
  if (s.type === 0) {
    return t('每 {{n}} {{unit}}', {
      n: s.interval_every ?? 0,
      unit: t(INTERVAL_PERIOD_ITEMS[s.interval_period ?? 'seconds'] ?? '秒'),
    })
  }
  const parts = (s.crontab ?? '').split(/\s+/)
  if (parts.length !== 5) return s.crontab ?? ''
  const [min, hour, dom, mon, dow] = parts
  if (dom === '*' && mon === '*' && dow === '*') {
    if (hour === '*' && min === '*') return t('每分钟')
    if (hour === '*') return t('每小时第 {{min}} 分', { min })
    return t('每天 {{time}}', { time: `${hour.padStart(2, '0')}:${min.padStart(2, '0')}` })
  }
  return s.crontab
}
