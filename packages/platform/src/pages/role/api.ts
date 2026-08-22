import { infiniteQueryOptions, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import type { User } from '../user/api'

export type Role = {
  id: string
  /** 稳定引用键。给配置和外部系统用 —— 创建后不可改（后端 UpdateRoleParam 里没有它） */
  code: string
  name: string
  status: number
  is_filter_scopes: boolean
  remark: string | null
  created_time: string
  updated_time: string | null
}

/**
 * 角色菜单树：`/roles/{id}/menus` 只返回**该角色已授权**的菜单，拼成树。
 *
 * 注意它拼树用的是 `traversal_to_tree`：父节点没被授权的孤儿子节点会被提到根，
 * 而不是丢掉 —— 所以「节点独立」模式下勾了按钮没勾菜单，回读时也不会丢。
 */
export type MenuNode = {
  id: string
  title: string
  name: string
  path: string | null
  type: number
  perms: string | null
  icon: string | null
  parent_id: string | null
  sort: number
  status: number
  children?: MenuNode[] | null
}

export type RoleListParams = { page: number; size: number; name?: string; code?: string; status?: number }

export const roleKeys = {
  all: ['sys', 'role'] as const,
  list: (p: RoleListParams) => [...roleKeys.all, 'list', p] as const,
  detail: (id: string) => [...roleKeys.all, id, 'detail'] as const,
  menus: (id: string) => [...roleKeys.all, id, 'menus'] as const,
  scopes: (id: string) => [...roleKeys.all, id, 'scopes'] as const,
}

function qs(p: RoleListParams) {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.name) s.set('name', p.name)
  if (p.code) s.set('code', p.code)
  if (p.status !== undefined) s.set('status', String(p.status))
  return s.toString()
}

export const rolesQuery = (p: RoleListParams) =>
  queryOptions({
    queryKey: roleKeys.list(p),
    queryFn: () => api.GET<PageData<Role>>(`/api/v1/sys/roles?${qs(p)}`),
    placeholderData: (prev) => prev,
  })

/** 左栏选择器一次取多少 —— 一屏放得下约 12 个，取 30 让首屏基本不用滚就够选 */
export const ROLE_SCROLL_SIZE = 30

/**
 * 左栏用的**滚动加载**版本。
 *
 * 为什么不复用 `rolesQuery` + 页码：左栏是个「快速跳到某个角色」的选择器，
 * 分页条在 288px 宽的栏里意味着「滚到底 → 点下一页 → 再滚回顶部找」，
 * 而滚动加载让这件事退化成「一直滚」。
 *
 * ⚠️ queryKey 要和 `rolesQuery` 区分开（多一个 'infinite' 段）——
 * 两者的数据形状不同（`InfiniteData` vs `PageData`），共用 key 会在
 * 两个组件同时挂载时互相覆盖缓存。
 */
export const rolesInfiniteQuery = (p: Omit<RoleListParams, 'page' | 'size'>) =>
  infiniteQueryOptions({
    queryKey: [...roleKeys.all, 'list', 'infinite', p] as const,
    queryFn: ({ pageParam }) =>
      api.GET<PageData<Role>>(`/api/v1/sys/roles?${qs({ ...p, page: pageParam, size: ROLE_SCROLL_SIZE })}`),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.total_pages ? last.page + 1 : undefined),
    placeholderData: (prev) => prev,
  })

/**
 * 按 id 取单个角色。
 *
 * 存在的理由：角色列表是**分页**的，`?role=<id>` 深链指向的角色可能不在当前页。
 * 只在当前页里 find 会静默落回第一条 —— 那意味着「你以为在给角色 X 配权限，
 * 实际写的是列表第一个角色」。所以页内找不到时要按 id 单独取。
 */
export const roleDetailQuery = (id: string) =>
  queryOptions({
    queryKey: roleKeys.detail(id),
    queryFn: () => api.GET<Role>(`/api/v1/sys/roles/${id}`),
    enabled: Boolean(id),
    retry: false,
  })

/** 全量菜单树（用于授权面板的可选项） */
export const allMenuTreeQuery = queryOptions({
  queryKey: ['sys', 'menu', 'tree'] as const,
  queryFn: () => api.GET<MenuNode[]>('/api/v1/sys/menus'),
  staleTime: 5 * 60_000,
})

/** 该角色已拥有的菜单树 */
export const roleMenusQuery = (id: string) =>
  queryOptions({
    queryKey: roleKeys.menus(id),
    queryFn: () => api.GET<MenuNode[] | null>(`/api/v1/sys/roles/${id}/menus`),
    enabled: Boolean(id),
  })

/** 更新用的载荷 —— **不含 `code`**，后端 `UpdateRoleParam` 也没有这个字段 */
export type RoleBody = {
  name: string
  status: number
  is_filter_scopes: boolean
  remark?: string | null
}

/** 创建时才带 code —— 编码只在这一刻能定 */
export type CreateRoleBody = RoleBody & { code: string }

export function useCreateRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateRoleBody) => api.POST('/api/v1/sys/roles', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  })
}

export function useUpdateRole() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: RoleBody }) =>
      api.PUT(`/api/v1/sys/roles/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  })
}

export function useDeleteRoles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.DELETE('/api/v1/sys/roles', { body: { pks: ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: roleKeys.all }),
  })
}

export function useUpdateRoleMenus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, menus }: { id: string; menus: string[] }) =>
      api.PUT(`/api/v1/sys/roles/${id}/menus`, { body: { menus } }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: roleKeys.menus(v.id) })
      // 授权变了，当前用户的侧边栏与权限码可能随之变化
      qc.invalidateQueries({ queryKey: ['auth'] })
    },
  })
}

/** 收集树里所有节点 id */
export function collectMenuIds(nodes: MenuNode[] | null | undefined): string[] {
  const out: string[] = []
  const walk = (list: MenuNode[]) => {
    for (const n of list) {
      out.push(n.id)
      if (n.children?.length) walk(n.children)
    }
  }
  walk(nodes ?? [])
  return out
}

// ─── 数据范围（角色 ↔ /api/v1/sys/data-scopes） ────────────────────────────────
// `sys:role:scope:edit` 这个权限码建库时就有，但一直没有界面用它 ——
// 角色的 is_filter_scopes 开着却绑不了范围，等于空转。

export type DataScopeLite = { id: string; name: string; status: number }

/** 全部数据范围（选项源）。数量级很小，一次拉完不分页 */
export const allDataScopesQuery = queryOptions({
  queryKey: ['sys', 'data-scope', 'all'] as const,
  queryFn: () => api.GET<PageData<DataScopeLite>>('/api/v1/sys/data-scopes?page=1&size=100'),
  staleTime: 5 * 60_000,
})

/** 该角色已绑定的数据范围 id（后端返回 list[int]，编码层已转字符串） */
export const roleScopesQuery = (id: string) =>
  queryOptions({
    queryKey: roleKeys.scopes(id),
    queryFn: () => api.GET<string[] | null>(`/api/v1/sys/roles/${id}/scopes`),
    enabled: Boolean(id),
  })

export function useUpdateRoleScopes() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, scopes }: { id: string; scopes: string[] }) =>
      api.PUT(`/api/v1/sys/roles/${id}/scopes`, { body: { scopes } }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: roleKeys.scopes(v.id) })
    },
  })
}

// ─── 角色下的用户 ──────────────────────────────────────────────────────────────

export type RoleUserParams = { role: string; page: number; size: number }

/** 用户列表的 `role` 入参是本仓库加的（上游没有），见 crud_user.get_select */
export const roleUsersQuery = (p: RoleUserParams) =>
  queryOptions({
    queryKey: [...roleKeys.all, p.role, 'users', p.page, p.size] as const,
    queryFn: () =>
      api.GET<PageData<User>>(
        `/api/v1/sys/users?role=${p.role}&page=${p.page}&size=${p.size}`
      ),
    enabled: Boolean(p.role),
    placeholderData: (prev) => prev,
  })

/** 添加用户时的候选列表（不带 role 过滤，返回的 user.roles 用来标已在本角色的） */
export const candidateUsersQuery = (p: { keyword?: string; page: number; size: number }) =>
  queryOptions({
    queryKey: ['sys', 'user', 'candidates', p] as const,
    queryFn: () => {
      const s = new URLSearchParams({ page: String(p.page), size: String(p.size) })
      if (p.keyword) s.set('username', p.keyword)
      return api.GET<PageData<User>>(`/api/v1/sys/users?${s}`)
    },
    placeholderData: (prev) => prev,
  })

/**
 * 某个用户的**全部**角色。
 *
 * 列表接口带 `role` 过滤时返回的 `roles` 只剩被过滤的那一个（见 crud_user.get_select
 * 里的注释），所以「移出后他还剩几个角色」这种判断必须单独查。
 */
export const userRolesQuery = (userId: string) =>
  queryOptions({
    queryKey: ['sys', 'user', userId, 'roles'] as const,
    queryFn: () => api.GET<{ id: string; name: string }[]>(`/api/v1/sys/users/${userId}/roles`),
    enabled: Boolean(userId),
  })

/**
 * 角色 ↔ 用户的增删。
 *
 * 走 `POST/DELETE /roles/{id}/users` 而**不是** `PUT /users/{id}`：
 * 后者收的是整个用户对象，为了改一个角色要把 username/email/dept 全带上回传，
 * 任何一个字段读漏都会被顺手清掉。这两个接口只动 `user_role` 一行关联。
 */
function invalidateRoleUsers(qc: ReturnType<typeof useQueryClient>, roleId: string) {
  qc.invalidateQueries({ queryKey: [...roleKeys.all, roleId, 'users'] })
  qc.invalidateQueries({ queryKey: ['sys', 'user'] })
  // 自己给自己加/减角色时，侧边栏和权限码要跟着变
  qc.invalidateQueries({ queryKey: ['auth'] })
}

export function useAddRoleUsers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, users }: { id: string; users: string[] }) =>
      api.POST(`/api/v1/sys/roles/${id}/users`, { body: { users } }),
    onSuccess: (_d, v) => invalidateRoleUsers(qc, v.id),
  })
}

export function useRemoveRoleUsers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, users }: { id: string; users: string[] }) =>
      api.DELETE(`/api/v1/sys/roles/${id}/users`, { body: { users } }),
    onSuccess: (_d, v) => invalidateRoleUsers(qc, v.id),
  })
}
