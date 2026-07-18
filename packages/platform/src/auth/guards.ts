import { redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { t } from '@admin/i18n'

import { codesQuery, meQuery } from './queries'
import { isAuthenticated } from './session'

/**
 * 路由级守卫。
 *
 * `beforeLoad` 是**导航期**拦截（不是渲染期），所以不会闪一下再跳走。
 * 它可以是 async —— 用 `ensureQueryData` 读权限：有缓存直接返回，没有才请求一次。
 *
 * 这样 auth/perms 的唯一真相仍在 query cache 里，不需要额外的 client store。
 */
export type GuardContext = { queryClient: QueryClient }

/** 未登录 → 踢去登录页 */
export async function requireAuth({ context, location }: { context: GuardContext; location: { href: string } }) {
  if (!isAuthenticated()) {
    throw redirect({ to: '/sign-in' as never, search: { redirect: location.href } as never })
  }
  // 拉一次当前用户，顺带验证 token 真的有效（失效会走 401 → 单飞刷新 → 失败则清会话）
  await context.queryClient.ensureQueryData(meQuery)
}

/** 需要指定权限码；超管免检 */
export function requirePerm(...perms: string[]) {
  return async ({ context, location }: { context: GuardContext; location: { href: string } }) => {
    await requireAuth({ context, location })
    const me = context.queryClient.getQueryData(meQuery.queryKey)
    if (me?.is_superuser) return
    const codes = await context.queryClient.ensureQueryData(codesQuery)
    const ok = perms.every((p) => codes.includes(p))
    if (!ok) {
      throw redirect({ to: '/403' as never, search: { from: location.href, need: perms.join(',') } as never })
    }
  }
}

/**
 * 需要超级管理员。
 *
 * 有些接口是 `DependsSuperUser` 而不是权限码保护的（监控三件套里的
 * 服务器监控与在线用户就是），菜单表里它们的 `perms` 是空串 ——
 * 用 `requirePerm()` 检查不到任何东西，等于没设防：页面能打开，
 * 进去之后所有请求 403，只能看到一片空白。
 */
export function requireSuperUser() {
  return async ({ context, location }: { context: GuardContext; location: { href: string } }) => {
    await requireAuth({ context, location })
    const me = context.queryClient.getQueryData(meQuery.queryKey)
    if (me?.is_superuser) return
    throw redirect({ to: '/403' as never, search: { from: location.href, need: t('超级管理员') } as never })
  }
}
