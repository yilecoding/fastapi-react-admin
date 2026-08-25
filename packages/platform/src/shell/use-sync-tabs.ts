import * as React from 'react'
import { useRouterState } from '@tanstack/react-router'

import { isAuthenticated } from '../auth/session'
import { makeTabKey, useTabStore } from './tab-store'

/**
 * 把路由变化同步进 tab store。
 *
 * ⚠️ 必须用 `resolvedLocation` 而不是 `location`，并且只在 `status === 'idle'` 时同步。
 *
 * 原因：导航期间 `state.location` 会**先于** `state.matches` 更新
 * （TanStack 先乐观改地址，再解析匹配）。用 `location` 的话会出现
 * 「matches 还是旧路由、location 已是新路由」的窗口，结果旧 tab 的 href
 * 被写成新路由的地址 —— 点它跳不动，两个 tab 还会撞成同一个 key
 * （React 报 duplicate key）。
 *
 * `resolvedLocation` 是与当前 matches 对应的那个地址，天然一致。
 * 实测确认：`router.state` 同时含 `location` 与 `resolvedLocation`。
 *
 * tab 标题三级回退：
 *   1. 路由 `staticData.title`
 *   2. 后端菜单树里 path 匹配到的 `meta.title`
 *   3. routeId 兜底
 *
 * 详情页（如 /orders/$id）必须走 loader 返回的实体名，
 * 因为 staticData 是静态的 —— 否则 /orders/1 和 /orders/2 会同名。
 */
export function useSyncTabs(resolveTitle?: (path: string) => string | undefined) {
  const snap = useRouterState({
    select: (s) => {
      const leaf = s.matches[s.matches.length - 1]
      const loc = s.resolvedLocation ?? s.location
      return {
        idle: s.status === 'idle',
        routeId: leaf?.routeId,
        params: leaf?.params,
        search: leaf?.search,
        staticData: leaf?.staticData as { title?: string; pinned?: boolean } | undefined,
        href: loc.href,
        pathname: loc.pathname,
      }
    },
  })

  const open = useTabStore((s) => s.open)

  React.useEffect(() => {
    const { idle, routeId, params, search, staticData, href, pathname } = snap
    // 导航未完成时 matches 与地址可能不一致，等 idle 再同步
    if (!idle) return
    /*
     * 🔴 没有登录态就不往标签条里加东西。
     *
     * 退出登录时 `logout()` 会清空标签页（`tab-store.reset()`），但**这个 effect
     * 会在那之后再跑一次**，把当前页原样加回去 —— 于是「退出后标签条清空了」
     * 只成立半秒：`qc.clear()` 让侧边栏 query 变空 → `resolveTitle` 的身份变了
     * → 依赖数组里它变了 → effect 重跑 → `open()`。
     *
     * 实测（issue #29 的修复过程）：退出后 sessionStorage 里从
     * 「仪表盘/参数配置」变成「参数配置」—— 被清掉的只是「不是当前页」的那些，
     * 而当前页恰恰是最要紧的那一个：它就是下次恢复出来的 activeKey。
     */
    if (!isAuthenticated()) return
    if (!routeId || routeId.endsWith('/_auth') || routeId === '__root__') return
    const sd = staticData ?? {}
    const title = sd.title ?? resolveTitle?.(pathname) ?? routeId
    open({
      key: makeTabKey(routeId, params),
      href,
      routeId,
      title,
      snapshot: { params, search },
      pinned: sd.pinned ?? false,
      closable: !(sd.pinned ?? false),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap.idle, snap.routeId, JSON.stringify(snap.params), snap.href, open, resolveTitle])
}
