import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'

export type Dept = {
  id: string
  /** 稳定引用键。给配置、数据权限规则和外部系统用 —— 创建后不可改（后端 UpdateDeptParam 里没有它） */
  code: string
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

export type DeptFilters = { name?: string; code?: string; leader?: string; status?: number }

export const deptKeys = {
  all: ['sys', 'dept'] as const,
  tree: (f: DeptFilters = {}) => [...deptKeys.all, 'tree', f] as const,
}

function qs(f: DeptFilters) {
  const s = new URLSearchParams()
  if (f.name) s.set('name', f.name)
  if (f.code) s.set('code', f.code)
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

/** 更新用的载荷 —— **不含 `code`**，后端 `UpdateDeptParam` 也没有这个字段 */
export type DeptBody = {
  name: string
  parent_id?: string | null
  sort: number
  leader?: string | null
  phone?: string | null
  email?: string | null
  status: number
}

/** 创建时才带 code —— 编码只在这一刻能定 */
export type CreateDeptBody = DeptBody & { code: string }

export function useCreateDept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateDeptBody) => api.POST('/api/v1/sys/depts', { body }),
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
