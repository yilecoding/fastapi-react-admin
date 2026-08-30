import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import { TONE_CLASS } from '../_shared/status'

export type DictType = {
  id: string
  name: string
  code: string
  remark: string | null
  created_time: string
}

export type DictData = {
  id: string
  type_id: string
  type_code: string
  label: string
  value: string
  color: string | null
  sort: number
  status: number
  remark: string | null
  created_time: string
}

export const dictKeys = {
  all: ['sys', 'dict'] as const,
  types: (p: { page: number; size: number; name?: string; code?: string }) =>
    [...dictKeys.all, 'types', p] as const,
  datas: (p: { page: number; size: number; type_id?: string; label?: string }) =>
    [...dictKeys.all, 'datas', p] as const,
}

export const dictTypesQuery = (p: { page: number; size: number; name?: string; code?: string }) =>
  queryOptions({
    queryKey: dictKeys.types(p),
    queryFn: () => {
      const s = new URLSearchParams({ page: String(p.page), size: String(p.size) })
      if (p.name) s.set('name', p.name)
      if (p.code) s.set('code', p.code)
      return api.GET<PageData<DictType>>(`/api/v1/sys/dict-types?${s}`)
    },
    placeholderData: (prev) => prev,
  })

export const dictDatasQuery = (p: { page: number; size: number; type_id?: string; label?: string }) =>
  queryOptions({
    queryKey: dictKeys.datas(p),
    queryFn: () => {
      const s = new URLSearchParams({ page: String(p.page), size: String(p.size) })
      if (p.type_id) s.set('type_id', p.type_id)
      if (p.label) s.set('label', p.label)
      return api.GET<PageData<DictData>>(`/api/v1/sys/dict-datas?${s}`)
    },
    enabled: Boolean(p.type_id),
    placeholderData: (prev) => prev,
  })

export type DictTypeBody = { name: string; code: string; remark?: string | null }
export type DictDataBody = {
  type_id: string
  label: string
  value: string
  color?: string | null
  sort: number
  status: number
  remark?: string | null
}

const inv = (qc: ReturnType<typeof useQueryClient>) => () =>
  qc.invalidateQueries({ queryKey: dictKeys.all })

export function useCreateDictType() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (b: DictTypeBody) => api.POST('/api/v1/sys/dict-types', { body: b }),
    onSuccess: inv(qc),
  })
}
export function useUpdateDictType() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, body }: { id: string; body: DictTypeBody }) => api.PUT(`/api/v1/sys/dict-types/${id}`, { body }),
    onSuccess: inv(qc),
  })
}
export function useDeleteDictTypes() {
  const qc = useQueryClient()
  // 删除确认框自己接错误、留在原地重试（流派一），不指望全局兜底
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (ids: string[]) => api.DELETE('/api/v1/sys/dict-types', { body: { pks: ids } }),
    onSuccess: inv(qc),
  })
}
export function useCreateDictData() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (b: DictDataBody) => api.POST('/api/v1/sys/dict-datas', { body: b }),
    onSuccess: inv(qc),
  })
}
export function useUpdateDictData() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, body }: { id: string; body: DictDataBody }) => api.PUT(`/api/v1/sys/dict-datas/${id}`, { body }),
    onSuccess: inv(qc),
  })
}
/**
 * 单条删除和批量删除共用同一个接口，但错误处理策略不同：单条删除留在弹窗里
 * 原地重试（流派一），批量删除是部分失败语义，重试整个选中集合没有意义，
 * 照旧关弹窗走全局 toast——两处各自 `useDeleteDictDatas()` 一份互不影响的 mutation 实例。
 */
export function useDeleteDictDatas(opts: { suppressErrorToast?: boolean } = {}) {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: opts.suppressErrorToast ?? false },
    mutationFn: (ids: string[]) => api.DELETE('/api/v1/sys/dict-datas', { body: { pks: ids } }),
    onSuccess: inv(qc),
  })
}

/** 字典项的颜色标记 —— 后端存的是颜色名，这里映射到样式 */
export const COLOR_ITEMS: Record<string, string> = {
  default: '默认', primary: '主色', success: '成功', warning: '警告', red: '危险', gray: '灰色',
}
/**
 * 字典项的颜色（后端存的是色名，由用户在表单里挑）。
 * 与状态色同源 —— 三个重合的色板直接取 `_shared/status` 的 TONE_CLASS，
 * 不再各写一份 emerald/amber/destructive。
 */
export const COLOR_CLASS: Record<string, string> = {
  default: 'bg-muted text-foreground ring-border',
  primary: 'bg-primary/10 text-primary ring-primary/25',
  success: TONE_CLASS.success,
  warning: TONE_CLASS.warning,
  red: TONE_CLASS.danger,
  gray: TONE_CLASS.muted,
}
