import { queryOptions } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'

/**
 * 任务执行记录。
 *
 * ⚠️ 这张表由 **celery 自己**写（`app/task/database.py` 的 DatabaseBackend），
 * 前端只读和删 —— 没有新建/编辑，是刻意的。
 *
 * ⚠️ `id` 在这里是**自增整数**而不是雪花串，是全仓唯一的例外：
 * 这两张表是 celery 的管道，让「记录一次失败」依赖雪花初始化成功，
 * 等于雪花一挂连失败都记不下来（见 `model/result.py` 的注释）。
 */
export type TaskResult = {
  id: number
  task_id: string | null
  name: string | null
  status: string | null
  result: string | null
  traceback: string | null
  retries: number | null
  worker: string | null
  queue: string | null
  date_done: string | null
}

export type ResultListParams = {
  page: number
  size: number
  name?: string
  task_id?: string
  status?: string
  /** 结束时间起 / 止（含）。必须是完整时刻 —— 只给日期会静默丢掉最后一天 */
  start_time?: string
  end_time?: string
}

export const resultKeys = {
  all: ['task', 'result'] as const,
  list: (p: ResultListParams) => [...resultKeys.all, 'list', p] as const,
  detail: (id: number) => [...resultKeys.all, 'detail', id] as const,
}

function qs(p: ResultListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.name) s.set('name', p.name)
  if (p.task_id) s.set('task_id', p.task_id)
  if (p.status) s.set('status', p.status)
  if (p.start_time) s.set('start_time', p.start_time)
  if (p.end_time) s.set('end_time', p.end_time)
  return s.toString()
}

export const resultsQuery = (p: ResultListParams) =>
  queryOptions({
    queryKey: resultKeys.list(p),
    queryFn: () => api.GET<PageData<TaskResult>>(`/api/v1/tasks/results?${qs(p)}`),
    placeholderData: (prev) => prev,
  })

/**
 * 详情。列表里不带 `result` / `traceback` 也能用，但详情抽屉要它们 ——
 * 异常栈是长文本，塞进表格列会把「任务名」挤没。
 */
export const resultDetailQuery = (id: number) =>
  queryOptions({
    queryKey: resultKeys.detail(id),
    queryFn: () => api.GET<TaskResult>(`/api/v1/tasks/results/${id}`),
  })

/**
 * celery 的任务状态。
 *
 * 值取自 `celery.states` —— 后端存的就是这些字面量，别自己造。
 * 这里的中文是**语言包 key**（中文原文即 key），渲染处过 `t()`。
 */
export const RESULT_STATUS_LABEL: Record<string, string> = {
  PENDING: '排队中',
  STARTED: '执行中',
  SUCCESS: '成功',
  FAILURE: '失败',
  RETRY: '重试中',
  REVOKED: '已撤销',
}

export const RESULT_STATUS_FILTER_ITEMS: Record<string, string> = {
  all: '全部状态',
  SUCCESS: '成功',
  FAILURE: '失败',
  STARTED: '执行中',
  RETRY: '重试中',
  PENDING: '排队中',
  REVOKED: '已撤销',
}

/** 状态 → `_shared/status.tsx` 的色板色调 */
export const RESULT_STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'muted'> = {
  SUCCESS: 'success',
  FAILURE: 'danger',
  RETRY: 'warning',
  STARTED: 'warning',
  PENDING: 'muted',
  REVOKED: 'muted',
}
