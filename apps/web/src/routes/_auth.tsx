import * as React from "react"
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router"

import { requireAuth } from "@admin/platform/auth/guards"
import { AppSidebar } from "@admin/platform/shell/app-sidebar"
import { CommandMenu, CommandTrigger } from "@admin/platform/shell/command-menu"
import { HelpMenu } from "@admin/platform/shell/help-menu"
import { UploadTray } from "@admin/platform/shell/upload-tray"
import { TenonMark } from "@/components/tenon-mark"
import { BRAND } from "@/lib/brand"
import { NavBreadcrumb } from "@admin/platform/shell/nav-breadcrumb"
import { usePreferences } from "@admin/platform/shell/preferences"
import { TabBar } from "@admin/platform/shell/tab-bar"
import { TabOutlet } from "@admin/platform/shell/tab-outlet"
import { useTabStore } from "@admin/platform/shell/tab-store"
import { useSyncTabs } from "@admin/platform/shell/use-sync-tabs"
import { useSidebar } from "@admin/platform/shell/use-sidebar"
import { usePresence } from "@admin/platform/shell/use-presence"
import { useSessionHeartbeat } from "@admin/platform/auth/activity"
import { sendHeartbeat } from "@admin/platform/auth/session"
import { PlatformProvider } from "@admin/platform/shell/platform-context"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@admin/ui/components/sidebar"
import { Separator } from "@admin/ui/components/separator"
import { cn } from "@admin/ui/lib/utils"

import { pageRegistry } from "@/lib/page-registry"
import { buildValidPaths, makeIsValidPath } from "@/lib/valid-paths"
import { NotificationBell } from "@admin/platform/pages/notification/bell"
import { NoticeBanner } from "@admin/platform/pages/notice/banner"
import { NoticePopupHost } from "@admin/platform/pages/notice/popup-host"
import { AiDrawer, AiDrawerTrigger } from "@admin/platform/pages/ai-chat/drawer"
import { GithubLink } from "@/components/github-link"
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
  // 一直在看页面、不发请求的人靠它保活（空闲只看记录下来的最后活跃，#138）
  useSessionHeartbeat(sendHeartbeat)

  // 顶栏面包屑：活动 tab 的 URL 决定链路,tab 自己的标题兜底
  // hideInMenu 的页面（个人中心那类)不进 nav 树,链路查不到时用它
  const activePath = useRouterState({ select: (s) => s.location.pathname })
  // 面包屑的父级和最后一级都从**同一个**路由匹配里取：最后一级原来用页签的标题，而页签要等导航空闲后才切过去，
  // 中间有一两帧读成「应用管理 › 应用管理」（#220 评审）
  const activeParent = useRouterState({
    select: (s) => (s.matches[s.matches.length - 1]?.staticData as { parent?: string } | undefined)?.parent,
  })
  const activeStaticTitle = useRouterState({
    select: (s) => (s.matches[s.matches.length - 1]?.staticData as { title?: string } | undefined)?.title,
  })
  const showTabs = usePreferences((s) => s.showTabs)
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
          {/* 窄屏（< sm）不显示面包屑：页名在标签上已经有了。原来在 390 宽下两级文字被 truncate 压到 0 宽，
              中间的「›」不会收缩，孤零零地贴在搜索按钮左边，像一个残影（#210）。
              关掉多标签页时标签条整个不渲染，那时面包屑是唯一看得见页名的地方，照旧显示（#216 评审） */}
          <Separator orientation="vertical" className={cn("me-2 data-[orientation=vertical]:h-4", showTabs && "max-sm:hidden")} />
          <div className={cn("min-w-0", showTabs && "max-sm:hidden")}>
            <NavBreadcrumb nav={nav} activePath={activePath} fallbackTitle={activeParent ? (activeStaticTitle ?? activeTabTitle) : activeTabTitle} parentPath={activeParent} />
          </div>
          {/* 命令面板入口：⌘K 也能开，但快捷键不摆出来就等于只有作者知道 */}
          <div className="ms-auto flex items-center gap-2">
            <CommandTrigger />
            <GithubLink />
            {/* 帮助：重看功能引导 / 快捷键清单。没有这个按钮，那两样只有知道的人才找得到 */}
            <HelpMenu />
            {/* 通知铃铛。它是外壳家具（永远处于「当前匹配」的位置），
                不是标签页，所以可以用 router —— 别把它注册进 page-registry */}
            <NotificationBell />
            {/* AI 抽屉入口。同铃铛，是外壳家具不是标签页 —— 别注册进 page-registry */}
            <AiDrawerTrigger />
            <UserMenu />
          </div>
        </header>
        {/* 置顶 + 紧急 + 没读的公告（#190）。同铃铛，外壳家具不是标签页 —— 别注册进 page-registry */}
        <NoticeBanner />
        <TabBar />
        <AiDrawer />
        {/* 这一层是 div 不是 main —— `SidebarInset` 自己渲染的就是 <main>，
            再嵌一个会出现两个 main 地标，读屏「跳到主内容」不知道该去哪个。
            四边内边距统一在这里给，上下左右同一个 16px（页面级块一律不加 px-* / py-*，
            见 CLAUDE.md；页面最外层走 `pages/_shared/page-shell.tsx`）。
            原来这里只给 px-4，上下由每页手抄 `py-4 md:py-6` —— 桌面上顶 24 / 左右 16，
            抄漏的页贴着标签条、抄成 py-3 的是 12（#209）。 */}
        {/* data-slot 是给这一层的**地标**（和 sidebar-inset / table-container 同一套做法），
            排障时能一眼定位「外壳的内容列」。
            ⚠️ 曾经拿它挂过 `scrollbar-gutter: stable`，已经撤了 ——
            表格页真正会滚的是 `table-container`，这一层根本不滚，留槽位只会白占
            10px 并让表格右边缘比页头短一截。理由见 globals.css 里那段。 */}
        <div
          data-slot="content-scroll"
          className="flex flex-1 flex-col p-4 content-scroll:min-h-0 content-scroll:overflow-y-auto content-scroll:overflow-x-hidden"
        >
          <TabOutlet registry={pageRegistry} />
        </div>

        {/* 命令面板 + 快捷键帮助。挂在外壳里（不是页面里）—— 它要在任何 tab 上都能呼出 */}
        <CommandMenu options={options} />
        {/* 登录后弹窗（#190）。外壳导览不自动弹，只从顶栏「帮助」/ ⌘K 手动开；开着时新到的弹窗等它结束（shell/tour/gate.ts） */}
        <NoticePopupHost />
        {/* 右下角上传浮窗。外壳家具：队列在 store 里，切 tab / 关 tab 都不影响 */}
        <UploadTray />
      </SidebarInset>
    </SidebarProvider>
    </PlatformProvider>
  )
}
