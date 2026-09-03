import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as React from 'react'

import { api } from '@/lib/api'
import { useSession } from '@/lib/session'

/**
 * 权限判断 —— **形状照 web 的 `platform/src/auth/use-perm.ts` 抄，实现独立。**
 *
 * 数据源是 `GET /auth/codes`：登录后拉一次，返回一串形如 `sys:user:add` 的码。
 * 移动端在这之前**完全没有权限概念** —— `CurrentUser` 里只有 `roles: string[]`
 * （那是角色**名字**，不是码，不能拿来判断），于是「应用」那一屏的副标题写着
 * 「按你的权限列出能进的功能模块」，而它做不到。
 *
 * ## 🔴 `known` 这一位是必须的（硬纪律 9）
 *
 * 权限码拉失败时 `can()` 会一律返回 false → 入口全部消失 → 用户看到的是
 * **一个功能不存在的 App**，而不是「权限没问上，重试」。这和未读数那次
 * 是同一个物种（`lib/notifications.tsx` 里记着）：**「不知道」不等于「没有」。**
 * 所以调用方必须先看 `known` / `error`，再看 `can()`。
 *
 * ## 🔴 写操作要用 `canWrite()`，不是 `can()`
 *
 * 后端 `common/security/rbac.py` 的闸门是**有顺序**的，逐条读过：
 *
 * | 顺序 | 判断 | 说明 |
 * |---|---|---|
 * | 1 | `is_superuser` | **直接放行**，后面几道全部跳过 |
 * | 2 | 有没有启用的角色 | 否则 403 `role_locked` |
 * | 3 | 角色有没有挂菜单 | 否则 403 `menu_not_assigned` |
 * | 4 | **非 GET/OPTIONS 且 `is_staff` 为假 → 403** | ⚠️ 权限码还没开始校验 |
 * | 5 | 权限码在不在已分配菜单里 | 否则 403 |
 *
 * 第 4 道是新建账号最容易撞的：`is_staff` 默认 False，而 `AddUserParam` 里
 * **根本没有这个字段**（只能建完再改）。症状是「能登录、能看列表、所有写操作
 * 403」，而那三条 403 的文案都不提移动端。`canWrite()` 把这道闸门算进去，
 * 于是界面上不会出现一个点了必然 403 的按钮。
 */
export const codesKey = ['auth', 'codes'] as const

export function usePerm() {
  const { status, user } = useSession()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: codesKey,
    queryFn: () => api.GET('/api/v1/auth/codes'),
    enabled: status === 'authed',
    // 权限码在一次会话里几乎不变（改了角色要重新登录才生效），给长一点。
    // ⚠️ 但不能给 Infinity —— 超管在 web 端改了本人的角色菜单之后，
    // 移动端回到前台该能拿到新的（web 那边踩过一次，见 issue #65）
    staleTime: 5 * 60_000,
  })

  /*
   * ⚠️ `q.data ?? []` 不能直接用 —— **每次渲染都是一个新数组**，
   * 下面那三个 `useCallback` 的依赖就每帧都变，等于没记忆化
   * （`react-hooks/exhaustive-deps` 正好抓这个：「The 'codes' logical
   * expression could make the dependencies of useCallback change on every
   * render」）。这不只是性能：`can` 每帧换引用，会让把它放进依赖数组的
   * 调用方 effect 反复重跑。
   */
  const codes = React.useMemo(() => q.data ?? [], [q.data])
  const isSuperuser = user?.is_superuser ?? false
  const isStaff = user?.is_staff ?? false

  const can = React.useCallback(
    (...perms: string[]) => isSuperuser || perms.every((p) => codes.includes(p)),
    [isSuperuser, codes],
  )

  return {
    codes,
    isSuperuser,
    isStaff,

    /**
     * 🔴 权限码是不是**真的问到了**。超管不需要码，所以它也算「知道」。
     * 为假时界面要显示错误 + 重试，**不要**渲染成一个空的模块列表。
     */
    known: q.isSuccess || isSuperuser,
    error: q.error instanceof Error ? q.error.message : null,

    /** 全部满足 */
    can,
    /** 任一满足 */
    canAny: React.useCallback(
      (...perms: string[]) => isSuperuser || perms.some((p) => codes.includes(p)),
      [isSuperuser, codes],
    ),
    /** 写操作：权限码 **加上** `is_staff` 那道闸门（见上表第 4 行） */
    canWrite: React.useCallback(
      (...perms: string[]) => isSuperuser || (isStaff && can(...perms)),
      [isSuperuser, isStaff, can],
    ),

    refresh: React.useCallback(async () => {
      await qc.invalidateQueries({ queryKey: codesKey })
    }, [qc]),
  }
}
