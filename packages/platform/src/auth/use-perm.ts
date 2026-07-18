import { useQuery } from '@tanstack/react-query'

import { codesQuery, meQuery } from './queries'

/**
 * 权限判断 hook。
 *
 * 数据源是 `/auth/codes`（登录后拉一次，35 个形如 `sys:user:add` 的码），
 * 与路由守卫 `requirePerm` 共用同一份 query 缓存 —— 不会重复请求。
 */
export function usePerm() {
  const { data: codes = [] } = useQuery(codesQuery)
  const { data: me } = useQuery(meQuery)
  const superuser = me?.is_superuser ?? false

  return {
    codes,
    isSuperuser: superuser,
    /** 全部满足 */
    can: (...perms: string[]) => superuser || perms.every((p) => codes.includes(p)),
    /** 任一满足 */
    canAny: (...perms: string[]) => superuser || perms.some((p) => codes.includes(p)),
  }
}
