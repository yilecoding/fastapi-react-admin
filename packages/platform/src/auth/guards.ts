import { redirect } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { t } from '@admin/i18n'

import { restoreSession } from '../api-client/client'
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

/**
 * 未登录 → 先静默恢复，恢复不了再去登录页。
 *
 * access token 只在内存里（#138），刷新页面、新开标签页时手里都没有 —— 用 refresh cookie
 * （桌面端是主进程存的那份）换一枚。三种结果：
 *  - 恢复了：接着往下走
 *  - 会话结束了：去登录页，带上原因码（被踢 / 空闲 / 到期 …），登录页据此告诉用户为什么
 *  - 暂时失败（后端重启、网络抖）：**不去登录页**，抛给路由的错误页，那里有重试 ——
 *    这时候让人重新登录是错的，他的会话好好的
 */
export async function requireAuth({ context, location }: { context: GuardContext; location: { href: string } }) {
  if (!isAuthenticated()) {
    const outcome = await restoreSession()
    if (outcome.kind === 'transient') throw outcome.error
    if (outcome.kind === 'ended') {
      throw redirect({
        to: '/sign-in' as never,
        search: { redirect: location.href, reason: outcome.end.reason ?? undefined } as never,
      })
    }
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
