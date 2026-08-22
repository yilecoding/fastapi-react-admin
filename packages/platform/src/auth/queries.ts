import { queryOptions } from '@tanstack/react-query'

import { setDisplayTimeZone } from '@admin/i18n'

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
  /** 显示时区（IANA 标识）。只影响前端怎么显示时间，服务端计算不看它 */
  timezone: string
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
  // 时区在 queryFn 里就设好，**不要**改成组件里的 useEffect：
  //
  // 1. `formatDateTime` 读的是模块级变量、**不是响应式的** —— effect 里设，
  //    已经渲染完的表格不会重渲染，会一直用旧时区显示，直到那个页面自己重取数据
  // 2. 在这里设的话，`me` 的数据被任何组件读到之前时区就已经是对的了，
  //    没有「先按浏览器时区闪一下再跳」的过程
  //
  // 代价是 queryFn 带了副作用。可接受：它是幂等的纯赋值，且 `me` 是全 app
  // 只有一份的查询（`staleTime: Infinity`），不会被并发的多个调用者搅乱。
  queryFn: async () => {
    const me = await api.GET<CurrentUser>('/api/v1/sys/users/me')
    setDisplayTimeZone(me.timezone)
    return me
  },
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
