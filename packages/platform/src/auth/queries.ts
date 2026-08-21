import { queryOptions } from '@tanstack/react-query'

import { api } from '../api-client/client'
import type { CodesResponse, SidebarNode } from '../api-client/sidebar-types'

/**
 * `GET /sys/users/me` 的真实返回。
 *
 * ⚠️ 两处曾经写错、且都是静默出错的：
 * 1. `id` / `dept_id` 下发的是**字符串**（雪花 ID 超出 JS 安全整数，后端统一转字符串），
 *    不是 number —— 见 CLAUDE.md 硬纪律 6。
 * 2. `roles` 是**角色名字符串数组**（后端 `GetCurrentUserInfoWithRelationDetail`
 *    的 model_validator 把对象拍平成了 `list[str]`），不是对象数组。
 *    按对象读会拿到一片 undefined：既不报错，也什么都不显示。
 *    要完整的角色对象得走 `GET /sys/users/{pk}/roles`。
 */
export type CurrentUser = {
  id: string
  uuid: string
  username: string
  nickname: string
  email: string | null
  avatar: string | null
  phone: string | null
  status: number
  is_superuser: boolean
  is_staff: boolean
  is_multi_login: boolean
  dept_id: string | null
  /** 部门名称，不是 ID */
  dept: string | null
  /** 角色名称列表 */
  roles: string[]
  join_time: string
  last_login_time: string | null
}

export const authKeys = {
  all: ['auth'] as const,
  me: () => [...authKeys.all, 'me'] as const,
  codes: () => [...authKeys.all, 'codes'] as const,
  sidebar: () => [...authKeys.all, 'sidebar'] as const,
}

/**
 * 这三个查询都是**服务端状态**（来自后端、随角色变更过期、需失效重取），
 * 所以归 TanStack Query 管，不放进 client store。
 *
 * `staleTime: Infinity` + 登录/登出时 `queryClient.clear()`，
 * 避免出现「改了角色但菜单没变」这类缓存不一致。
 */
export const meQuery = queryOptions({
  queryKey: authKeys.me(),
  queryFn: () => api.GET<CurrentUser>('/api/v1/sys/users/me'),
  staleTime: Infinity,
  retry: false,
})

export const codesQuery = queryOptions({
  queryKey: authKeys.codes(),
  queryFn: () => api.GET<CodesResponse['data']>('/api/v1/auth/codes'),
  staleTime: Infinity,
  retry: false,
})

export const sidebarQuery = queryOptions({
  queryKey: authKeys.sidebar(),
  queryFn: () => api.GET<SidebarNode[]>('/api/v1/sys/menus/sidebar'),
  staleTime: Infinity,
  retry: false,
})
