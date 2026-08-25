import * as React from "react"
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router"

import { requireAuth } from "@admin/platform/auth/guards"
import { AppSidebar } from "@admin/platform/shell/app-sidebar"
import { TenonMark } from "@/components/tenon-mark"
import { BRAND } from "@/lib/brand"
import { NavBreadcrumb } from "@admin/platform/shell/nav-breadcrumb"
import { TabBar } from "@admin/platform/shell/tab-bar"
import { TabOutlet } from "@admin/platform/shell/tab-outlet"
import { useTabStore } from "@admin/platform/shell/tab-store"
import { useSyncTabs } from "@admin/platform/shell/use-sync-tabs"
import { useSidebar } from "@admin/platform/shell/use-sidebar"
import { usePresence } from "@admin/platform/shell/use-presence"
import { PlatformProvider } from "@admin/platform/shell/platform-context"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@admin/ui/components/sidebar"
import { Separator } from "@admin/ui/components/separator"

import { pageRegistry } from "@/lib/page-registry"
import { buildValidPaths, makeIsValidPath } from "@/lib/valid-paths"
import { UserMenu } from "@/components/user-menu"

export const Route = createFileRoute("/_auth")({
  beforeLoad: requireAuth,
  component: AuthLayout,
})

function AuthLayout() {
  const router = useRouter()
  // isValidPath 由 app 注入 —— platform 不知道 apps/web 的 routeTree
  const options = React.useMemo(() => ({ isValidPath: makeIsValidPath(router) }), [router])
  // 平台页面（如菜单管理）需要知道前端有哪些合法路由 —— 由 app 注入
  const platform = React.useMemo(() => {
    const isValidPath = makeIsValidPath(router)
    return { validPaths: [...buildValidPaths(router)].sort(), isValidPath }
  }, [router])
  const { nav } = useSidebar(options)

  // tab 标题回退到后端菜单树的 meta.title
  const resolveTitle = React.useCallback(
    (path: string) => {
      const find = (ns: typeof nav): string | undefined => {
        for (const n of ns) {
          if (n.path === path) return n.title
          const hit = find(n.children)
          if (hit) return hit
        }
      }
      return find(nav)
    },
    [nav]
  )
  useSyncTabs(resolveTitle)
  // 向后端上报「这个会话还开着」——「在线用户」页的实时连接列靠它才有真值
  usePresence(true)

  // 顶栏面包屑：活动 tab 的 URL 决定链路,tab 自己的标题兜底
  // hideInMenu 的页面（个人中心那类)不进 nav 树,链路查不到时用它
  const activePath = useRouterState({ select: (s) => s.location.pathname })
  const activeTabTitle = useTabStore((s) => s.tabs.find((tb) => tb.key === s.activeKey)?.title)

  return (
    <PlatformProvider value={platform}>
    {/*
      外壳的滚动方式由偏好里的 `scrollMode` 决定，落地成根节点上的
      `data-scroll-mode`（见 `shell/use-apply-preferences.ts`），这里用
      `content-scroll:` 前缀分叉。三层缺一不可：

        wrapper   h-svh + overflow-hidden  把外壳钉死在视口内（默认只有 min-h-svh）
        inset     min-h-0                  允许它被约束，否则内容一多就顶破 h-svh
         └ 内容层 min-h-0 + overflow-y-*   真正滚动的那一层

      ⚠️ 内容层上的 `min-h-0` 是**必须**的：它是列向 flex 的项，
      主轴上 `min-height` 默认是 `auto`（= 内容的 min-content 高），
      少了它这一层拒绝收缩 → `overflow-y-auto` 永远不触发 →
      表现成「设成内容区滚动了，但整页还是在滚」，而且 DevTools 里
      这一层明明有 overflow-y:auto，极难往「min-height」上想。
      横向那条同一个坑写在 CLAUDE.md 的 `min-width: auto` 一节。

      `overflow-x-hidden` 也不能省：CSS 规定一轴是 visible、另一轴不是时，
      visible 会计算成 auto —— 只写 overflow-y 会白得一条横向滚动条。
      页面内部该横滚的地方（宽表格）各自有 overflow-x-auto，不受影响。
    */}
    <SidebarProvider className="content-scroll:h-svh content-scroll:overflow-hidden">
      <AppSidebar
        options={options}
        title={BRAND.wordmark}
        mark={<TenonMark className="size-4" />}
      />
      <SidebarInset className="content-scroll:min-h-0">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger className="-ms-1" />
          <Separator orientation="vertical" className="me-2 data-[orientation=vertical]:h-4" />
          <NavBreadcrumb nav={nav} activePath={activePath} fallbackTitle={activeTabTitle} />
          <div className="ms-auto">
            <UserMenu />
          </div>
        </header>
        <TabBar />
        {/* 这一层是 div 不是 main —— `SidebarInset` 自己渲染的就是 <main>，
            再嵌一个会出现两个 main 地标，读屏「跳到主内容」不知道该去哪个。
            水平内边距统一在这里给（页面级块一律不加 px-*，见 CLAUDE.md）。 */}
        {/* data-slot 是给这一层的**地标**（和 sidebar-inset / table-container 同一套做法），
            排障时能一眼定位「外壳的内容列」。
            ⚠️ 曾经拿它挂过 `scrollbar-gutter: stable`，已经撤了 ——
            表格页真正会滚的是 `table-container`，这一层根本不滚，留槽位只会白占
            10px 并让表格右边缘比页头短一截。理由见 globals.css 里那段。 */}
        <div
          data-slot="content-scroll"
          className="flex flex-1 flex-col px-4 content-scroll:min-h-0 content-scroll:overflow-y-auto content-scroll:overflow-x-hidden"
        >
          <TabOutlet registry={pageRegistry} />
        </div>
      </SidebarInset>
    </SidebarProvider>
    </PlatformProvider>
  )
}
