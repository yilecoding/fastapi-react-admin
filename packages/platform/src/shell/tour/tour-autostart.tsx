import * as React from 'react'
import { useQuery } from '@tanstack/react-query'

import { meQuery } from '../../auth/queries'
import { useTabStore } from '../tab-store'
import { SHELL_TOUR } from './shell-tour'
import { startTour, tourSeen } from './tour'

const DASHBOARD_ROUTE_ID = '/_auth/dashboard'

/**
 * 等外壳稳定再弹。整页加载后 `activeKey` 是从 sessionStorage 恢复的、要等
 * `useSyncTabs` 纠正，这段窗口里两个 frame 都是 `data-visible="true"`（实测 ~300ms）；
 * 侧边栏的导航树也在这段时间里到。太早启动会量到半成品的布局。
 */
const SETTLE_MS = 800

/**
 * 首次登录自动弹外壳导览。挂在 `_auth.tsx` 里（和 `CommandMenu` 是兄弟），不渲染任何东西。
 *
 * 只在**仪表盘是当前页签**时弹：直接深链进某个列表页的人是来干活的，不打断。
 * 没弹成功（目标一个都解析不到）不记「看过了」，下次到仪表盘再试。
 */
export function TourAutostart() {
  const { data: me } = useQuery(meQuery)
  const userId = me?.id
  const activeRouteId = useTabStore((s) => s.tabs.find((tb) => tb.key === s.activeKey)?.routeId)

  React.useEffect(() => {
    if (!userId || activeRouteId !== DASHBOARD_ROUTE_ID) return
    if (tourSeen(userId, SHELL_TOUR)) return
    const timer = window.setTimeout(() => {
      // 🔴 触发时**再查一遍**。上面那次检查发生在 effect 运行的瞬间，而这中间隔着
      // SETTLE_MS —— 用户完全可能在这段时间里自己从顶栏「帮助」点开导览、看完关掉。
      // 不重查的话定时器到点会**再弹一次**，而用户刚刚才手动关掉它。
      if (tourSeen(userId, SHELL_TOUR)) return
      startTour(SHELL_TOUR, { userId })
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [userId, activeRouteId])

  return null
}
