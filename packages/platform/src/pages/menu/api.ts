import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api } from '../../api-client/client'

/** 0 目录 · 1 菜单 · 2 按钮 · 3 内嵌 · 4 外链 */
export const MENU_TYPE = { DIR: 0, MENU: 1, BUTTON: 2, IFRAME: 3, LINK: 4 } as const

export const MENU_TYPE_ITEMS: Record<string, string> = {
  '0': '目录', '1': '菜单', '2': '按钮', '3': '内嵌', '4': '外链',
}

export type Menu = {
  id: string
  title: string
  name: string
  path: string | null
  parent_id: string | null
  sort: number
  icon: string | null
  type: number
  perms: string | null
  status: number
  display: number
  link: string | null
  remark: string | null
  created_time: string
  children?: Menu[] | null
}

export const menuKeys = {
  all: ['sys', 'menu'] as const,
  tree: (f: { title?: string; status?: number }) => [...menuKeys.all, 'tree', f] as const,
}

export const menuTreeQuery = (f: { title?: string; status?: number } = {}) =>
  queryOptions({
    queryKey: menuKeys.tree(f),
    queryFn: () => {
      const s = new URLSearchParams()
      if (f.title) s.set('title', f.title)
      if (f.status !== undefined) s.set('status', String(f.status))
      const q = s.toString()
      return api.GET<Menu[]>(`/api/v1/sys/menus${q ? `?${q}` : ''}`)
    },
    placeholderData: (prev) => prev,
  })

export type MenuBody = {
  title: string
  name: string
  path?: string | null
  parent_id?: string | null
  sort: number
  icon?: string | null
  type: number
  perms?: string | null
  status: number
  display: number
  link?: string | null
  remark?: string | null
}

const inv = (qc: ReturnType<typeof useQueryClient>) => () => {
  qc.invalidateQueries({ queryKey: menuKeys.all })
  // 菜单变了，侧边栏和权限码都要重取
  qc.invalidateQueries({ queryKey: ['auth'] })
}

export function useCreateMenu() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: (b: MenuBody) => api.POST('/api/v1/sys/menus', { body: b }),
    onSuccess: inv(qc),
  })
}
export function useUpdateMenu() {
  const qc = useQueryClient()
  return useMutation({
    meta: { suppressErrorToast: true },
    mutationFn: ({ id, body }: { id: string; body: MenuBody }) => api.PUT(`/api/v1/sys/menus/${id}`, { body }),
    onSuccess: inv(qc),
  })
}
export function useDeleteMenu() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (id: string) => api.DELETE(`/api/v1/sys/menus/${id}`), onSuccess: inv(qc) })
}

/** 扁平化成「上级菜单」下拉选项；排除自身及子孙，且按钮不能当父级 */
export function parentMenuOptions(tree: Menu[], excludeId?: string): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = []
  const walk = (list: Menu[], depth: number) => {
    for (const m of list) {
      if (m.id === excludeId) continue
      if (m.type === MENU_TYPE.BUTTON) continue
      out.push({ id: m.id, label: `${'　'.repeat(depth)}${m.title}` })
      if (m.children?.length) walk(m.children, depth + 1)
    }
  }
  walk(tree, 0)
  return out
}

export function countMenus(list: Menu[]): number {
  return list.reduce((n, m) => n + 1 + countMenus(m.children ?? []), 0)
}
