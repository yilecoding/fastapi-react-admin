import * as React from 'react'
import { Activity, type ComponentType } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useTabStore } from './tab-store'

/**
 * 多页签渲染出口 —— **完全取代 `<Outlet />`**。
 *
 * `<Outlet />` 只渲染当前匹配的路由，切走即卸载、状态全丢。
 * 这里把所有已打开的 tab 同时挂载，用 React 19.2 的 `<Activity>` 控制显隐：
 *   mode="hidden" → display:none + **销毁 effects**（订阅被清理，不会 refetch 风暴）
 *                   但 DOM 与 state 保留 → 切回来原样恢复
 *
 * ⚠️ 三条硬约束（0.6 原型 + Phase 3 实测得出）：
 * 1. 不能与 `<Outlet />` 共存 —— 否则活动页走 Outlet，切换时仍会卸载丢状态
 * 2. 页面组件必须 **router-独立**：params/search 走 props，
 *    内部不得调 `Route.useSearch()` / `Route.useParams()`（隐藏 tab 没有 match 上下文）。
 *    需要改 search 时用注入的 `onSearchChange`
 * 3. 隐藏 tab 的 DOM 仍在文档树里 —— 任何 `document.querySelector` /
 *    全局 DOM 测量都会命中它们，必须限定在 `[data-visible="true"]` 内
 */
export type PageRegistry = Record<string, ComponentType<any>>

export function TabOutlet({ registry }: { registry: PageRegistry }) {
  const tabs = useTabStore((s) => s.tabs)
  const activeKey = useTabStore((s) => s.activeKey)
  const navigate = useNavigate()

  return (
    <>
      {tabs.map((tab) => {
        const Page = registry[tab.routeId]
        if (!Page) return null
        const visible = tab.key === activeKey
        return (
          <Activity key={tab.key} mode={visible ? 'visible' : 'hidden'} name={tab.key}>
            {/*
              key 里带上 revision：菜单里的「重新加载」把它 +1，
              这一层就整体卸载重挂 —— 页面被 <Activity> 保活，
              不换 key 是刷不掉的（state 和已取到的数据都会留着）。
              Activity 自己的 key 保持不变，保活边界不会被重建。
            */}
            <TabFrame
              key={`${tab.key}#${tab.revision ?? 0}`}
              tabKey={tab.key}
              visible={visible}
              href={tab.href}
              params={tab.snapshot.params}
              search={tab.snapshot.search}
              Page={Page}
              navigate={navigate}
            />
          </Activity>
        )
      })}
    </>
  )
}

function TabFrame({
  tabKey, visible, href, params, search, Page, navigate,
}: {
  tabKey: string
  visible: boolean
  href: string
  params: unknown
  search: unknown
  Page: ComponentType<any>
  navigate: ReturnType<typeof useNavigate>
}) {
  const pathname = React.useMemo(() => href.split('?')[0] ?? href, [href])

  // 页面改筛选/分页 → 写进 URL（视图状态的持久层，刷新后可恢复）
  const onSearchChange = React.useCallback(
    (next: Record<string, unknown>) => {
      const clean = Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined && v !== '' && v !== null)
      )
      void navigate({ to: pathname as never, search: clean as never, replace: true })
    },
    [navigate, pathname]
  )

  return (
    // min-w-0 不能省：隐藏 tab 的 DOM 仍在文档树里、**仍参与布局计算**，
    // 少了它，任何一页的宽内容（12 列的操作日志、监控页的宽卡片）都会把
    // SidebarInset 的 min-content 撑大，于是标签条右端连同工具区被挤出视口 ——
    // 表现就是「tab 被裁掉、看不到滚动按钮」。页面内部该滚的地方各自有 overflow-x-auto。
    // content-scroll:min-h-0 —— 「内容区滚动」模式下这条 flex 链必须允许收缩，
    // 否则 `min-height: auto`（= 内容的 min-content 高）会一路顶住，
    // 页面里那些想变成定高视区的块（列表页的表格框）永远拿不到约束，
    // 于是外层内容区照旧整块滚 —— 看着像「设置没生效」。整页滚动模式下这条是空操作。
    <div
      data-tab={tabKey}
      data-visible={visible}
      className="flex min-w-0 flex-1 flex-col content-scroll:min-h-0"
    >
      <Page params={params} search={search} onSearchChange={onSearchChange} />
    </div>
  )
}
