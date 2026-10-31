import * as React from 'react'
import { useQuery } from '@tanstack/react-query'

import { codesQuery, meQuery } from './queries'

const NO_CODES: string[] = []

/**
 * 权限判断 hook。
 *
 * 数据源是 `/auth/codes`（登录后拉一次，35 个形如 `sys:user:add` 的码），
 * 与路由守卫 `requirePerm` 共用同一份 query 缓存 —— 不会重复请求。
 *
 * ⚠️ codes 还没回来时 `can()` 恒为 `false`（超管除外）。要按权限**算东西**的调用方（工作台的可用卡片）
 * 得自己等 `codesQuery` 有数据再算，否则先算出一版「什么权限都没有」的结果。
 *
 * `can` / `canAny` 是稳定引用（codes / 超管身份不变就不变），可以放进 `useMemo` 的依赖里。
 */
export function usePerm() {
  const { data: codes = NO_CODES } = useQuery(codesQuery)
  const { data: me } = useQuery(meQuery)
  const superuser = me?.is_superuser ?? false

  /** 全部满足 */
  const can = React.useCallback(
    (...perms: string[]) => superuser || perms.every((p) => codes.includes(p)),
    [superuser, codes]
  )
  /** 任一满足 */
  const canAny = React.useCallback(
    (...perms: string[]) => superuser || perms.some((p) => codes.includes(p)),
    [superuser, codes]
  )

  return { codes, isSuperuser: superuser, can, canAny }
}
