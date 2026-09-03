import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import { ApiError } from '@admin/api'

/**
 * 取数层。
 *
 * 🔴 **加它的动机是三个已经修过的 bug 都是同一个根因**：每屏自己写
 * `useEffect` + `useState` 取数。
 *
 * | 修过的 bug | 手写取数的哪一面 |
 * |---|---|
 * | 通知页切页签的竞态（慢的那个后到会赢） | 没有请求版本管理 —— query 里筛选条件进 key 就没有这回事 |
 * | 未读数「不知道 vs 是 0」被混成一个 | 没有 `status` / `error` 的区分，只有一个 `T \| null` |
 * | 3 条 `set-state-in-effect` 警告 | effect 里同步置 loading 态 |
 *
 * ⚠️ **不引入 `@react-native-community/netinfo`**（官方 RN 集成用它接
 * `onlineManager`）—— 那是**原生模块，Expo Go 里没有**，装了本仓库赖以调试的
 * 那条路就断了（见本分册「设备」一节）。所以只接 `focusManager` 那一半，
 * 它走 `AppState`、纯 JS。代价是「离线时不重试」这个优化没有 ——
 * 请求照常失败、照常显示错误态，不影响正确性。
 */

/**
 * 🔴 **401 绝对不能重试。** 401 的收尾在 `@admin/api` 的客户端里
 * （单飞刷新 → 刷不回来就判会话结束 → 弹回登录屏）。query 层再重试一遍
 * 只会多打几个必然失败的请求，还会把「弹回登录屏」推迟几秒。
 *
 * 429（限流）同理：`/auth/captcha` 是 5 次/30 秒，重试就是拿配额换一次必然的失败。
 */
function retry(count: number, error: unknown): boolean {
  if (error instanceof ApiError && (error.isUnauthorized || error.isForbidden || error.isRateLimited)) return false
  if (error instanceof ApiError && error.isValidation) return false
  return count < 2
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry,
        // 移动端切回前台就重取，所以 staleTime 可以给得大方一些 ——
        // 不给的话每次进屏都打一次，蜂窝流量下很浪费
        staleTime: 30_000,
        // ⚠️ RN 上没有「窗口」概念，`refetchOnWindowFocus` 靠的是下面接的
        // `focusManager`；不接的话这个选项**静默无效**
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  })
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createQueryClient)

  // 🔴 RN 里「窗口聚焦」= App 回到前台。不接这一句，`refetchOnWindowFocus`
  // 是**静默无效**的（web 上它监听 `visibilitychange`，RN 没有那个事件）。
  React.useEffect(() => {
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      focusManager.setFocused(state === 'active')
    })
    return () => sub.remove()
  }, [])

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
