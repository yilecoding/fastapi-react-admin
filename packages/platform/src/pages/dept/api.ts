import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'

export type Dept = {
  id: string
  name: string
  parent_id: string | null
  sort: number
  leader: string | null
  phone: string | null
  email: string | null
  status: number
  created_time: string
  children: Dept[] | null
}

export type DeptFilters = { name?: string; leader?: string; status?: number }

export const deptKeys = {
  all: ['sys', 'dept'] as const,
  tree: (f: DeptFilters = {}) => [...deptKeys.all, 'tree', f] as const,
}

function qs(f: DeptFilters) {
  const s = new URLSearchParams()
  if (f.name) s.set('name', f.name)
  if (f.leader) s.set('leader', f.leader)
  if (f.status !== undefined) s.set('status', String(f.status))
  const q = s.toString()
  return q ? `?${q}` : ''
}

export const deptTreeQuery = (f: DeptFilters = {}) =>
  queryOptions({
    queryKey: deptKeys.tree(f),
    queryFn: () => api.GET<Dept[]>(`/api/v1/sys/depts${qs(f)}`),
    placeholderData: (prev) => prev,
  })

export type DeptBody = {
  name: string
  parent_id?: string | null
  sort: number
  leader?: string | null
  phone?: string | null
  email?: string | null
  status: number
}

export function useCreateDept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: DeptBody) => api.POST('/api/v1/sys/depts', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: deptKeys.all }),
  })
}

export function useUpdateDept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: DeptBody }) =>
      api.PUT(`/api/v1/sys/depts/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: deptKeys.all }),
  })
}

export function useDeleteDept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/sys/depts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: deptKeys.all }),
  })
}

/** 扁平化成「上级部门」下拉的选项；排除自身及其子孙（防止把自己挂到自己下面） */
export function parentOptions(tree: Dept[], excludeId?: string): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = []
  const walk = (list: Dept[], depth: number) => {
    for (const d of list) {
      if (d.id === excludeId) continue
      out.push({ id: d.id, label: `${'　'.repeat(depth)}${d.name}` })
      if (d.children?.length) walk(d.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}
