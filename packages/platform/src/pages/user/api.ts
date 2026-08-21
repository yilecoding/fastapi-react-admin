import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query'

import { api, type PageData } from '../../api-client/client'
import { t } from '@admin/i18n'

/**
 * ⚠️ 所有 ID 都是 **string** 不是 number。
 * 雪花 ID 超出 JS 安全整数范围，后端在编码层统一转成了字符串
 * （见 backend/utils/serializers.py: stringify_unsafe_ints）。
 * 前端千万不要 Number() 它 —— 会立刻丢精度。
 */
export type UserRole = { id: string; name: string; status: number }
export type UserDept = { id: string; name: string } | null

export type User = {
  id: string
  uuid: string
  username: string
  nickname: string
  email: string | null
  phone: string | null
  avatar: string | null
  status: number
  is_superuser: boolean
  is_staff: boolean
  is_multi_login: boolean
  dept_id: string | null
  dept: UserDept
  roles: UserRole[]
  join_time: string
  last_login_time: string | null
}

export type UserListParams = {
  page: number
  size: number
  username?: string
  phone?: string
  status?: number
  /** 部门 id（雪花，字符串） */
  dept?: string
  /** 角色 id（雪花，字符串） */
  role?: string
}

export type Dept = {
  id: string
  name: string
  parent_id: string | null
  sort: number
  status: number
  children?: Dept[]
}

/** 集中定义 key，避免 invalidate 时字符串拼错 */
export const userKeys = {
  all: ['sys', 'user'] as const,
  list: (p: UserListParams) => [...userKeys.all, 'list', p] as const,
  detail: (id: string) => [...userKeys.all, 'detail', id] as const,
}
export const deptKeys = { tree: () => ['sys', 'dept', 'tree'] as const }
export const roleKeys = { all: () => ['sys', 'role', 'all'] as const }

function qs(p: UserListParams): string {
  const s = new URLSearchParams()
  s.set('page', String(p.page))
  s.set('size', String(p.size))
  if (p.username) s.set('username', p.username)
  if (p.phone) s.set('phone', p.phone)
  if (p.status !== undefined) s.set('status', String(p.status))
  if (p.dept) s.set('dept', p.dept)
  if (p.role) s.set('role', p.role)
  return s.toString()
}

export const usersQuery = (p: UserListParams) =>
  queryOptions({
    queryKey: userKeys.list(p),
    queryFn: () => api.GET<PageData<User>>(`/api/v1/sys/users?${qs(p)}`),
    // 翻页时保留上一页数据，避免表格闪空
    placeholderData: (prev) => prev,
  })

export const deptTreeQuery = queryOptions({
  queryKey: deptKeys.tree(),
  queryFn: () => api.GET<Dept[]>('/api/v1/sys/depts'),
  staleTime: 5 * 60_000,
})

export const allRolesQuery = queryOptions({
  queryKey: roleKeys.all(),
  queryFn: () => api.GET<UserRole[]>('/api/v1/sys/roles/all'),
  staleTime: 5 * 60_000,
})

export type CreateUserBody = {
  username: string
  password: string
  nickname?: string | null
  email?: string | null
  phone?: string | null
  dept_id: string
  roles: string[]
}

export type UpdateUserBody = {
  username: string
  nickname: string
  dept_id?: string | null
  email?: string | null
  phone?: string | null
  avatar?: string | null
  roles: string[]
}

export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateUserBody) => api.POST('/api/v1/sys/users', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  })
}

export function useUpdateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateUserBody }) =>
      api.PUT(`/api/v1/sys/users/${id}`, { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  })
}

export function useDeleteUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.DELETE(`/api/v1/sys/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  })
}

/**
 * 批量删除。
 *
 * ⚠️ 后端只有 `DELETE /sys/users/{pk}` 单条接口（角色/数据范围那些是收数组的），
 * 所以这里并发发 N 个请求。用 `allSettled` 而不是 `all`：一条失败不该让
 * 已经删掉的那些无声无息 —— 失败条数要报给用户，缓存也照样失效。
 */
export function useDeleteUsers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => api.DELETE(`/api/v1/sys/users/${id}`))
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) throw new Error(t('{{failed}} / {{total}} 项删除失败', { failed, total: ids.length }))
    },
    onSettled: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  })
}

/** 部门树扁平化，供 Select 使用（带层级缩进） */
export function flattenDepts(tree: Dept[], depth = 0): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = []
  for (const d of tree) {
    out.push({ id: d.id, label: `${'　'.repeat(depth)}${d.name}` })
    if (d.children?.length) out.push(...flattenDepts(d.children, depth + 1))
  }
  return out
}

// ─── 超管专属：权限开关与重置密码 ────────────────────────────────────────────

/**
 * 切换用户权限位。
 *
 * ⚠️ 后端是**无参切换**（`PUT /{pk}/permissions?type=xxx` 不收 body，
 * 自己读当前值取反），不是「设置成某个值」—— 所以不能乐观更新成指定值。
 * ⚠️ 挂的是 `DependsSuperUser`，不是权限码；且服务端明确**禁止修改自身权限**
 * （`pk == request.user.id` 直接 403）。
 */
export type UserPermissionType = 'superuser' | 'staff' | 'status' | 'multi_login'

export function useToggleUserPermission() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, type }: { id: string; type: UserPermissionType }) =>
      api.PUT(`/api/v1/sys/users/${id}/permissions?type=${type}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: userKeys.all }),
  })
}

/**
 * 超管重置他人密码。
 *
 * 与「个人中心改自己密码」是**两个接口**：这个不需要旧密码，但同样要过
 * `validate_new_password`（长度/复杂度/历史复用，策略读 `sys_config`）——
 * 实测种子密码 `123456` 会被「密码必须包含字母」挡回来。
 * 客户端不复刻规则，直接把服务端的话显示出来。
 */
export function useResetUserPassword() {
  return useMutation({
    mutationFn: ({ id, password }: { id: string; password: string }) =>
      api.PUT(`/api/v1/sys/users/${id}/password`, { body: { password } }),
  })
}
