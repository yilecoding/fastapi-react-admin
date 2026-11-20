import * as React from 'react'
import { Activity, type ComponentType } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { Button } from '@admin/ui/components/button'
import { QueryError } from '@admin/ui/components/query-error'

import { isRemovable, useTabStore } from './tab-store'
import { useTabActions } from './use-tab-actions'

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

/**
 * 本 tab 的根节点（`[data-tab]`）—— 由 URL 驱动打开的浮层把 portal 挂到这里。
 *
 * 🔴 **由 URL 驱动打开的浮层（抽屉 / 弹窗）必须用它。** 浮层走 portal 挂在 `<body>` 下，
 * 不在 `<Activity>` 隐藏的那棵 DOM 里 —— 实测：审批中心的详情抽屉开在 `?id=` 上，
 * 刷新后那个 tab 在**后台**被恢复出来，抽屉照样渲染，压在前台的消息中心上面，把点击全挡住，
 * 而前台那一页看起来像「点了没反应」。点出来的浮层（useState 开的）没这个问题 ——
 * 切 tab 之前你已经在前台把它关了，或者它就开在前台。
 *
 * 修法是把浮层的 portal 挂进**本 tab 的根节点**（`useTabPortalContainer()` → `SheetContent container`）：
 * `<Activity>` 把后台 tab 的根节点 `display:none`，浮层跟着藏起来，而浮层里的状态（填了一半的表单、
 * 写好的意见）原样保活 —— 切回来还在。
 *
 * ⚠️ 走过的两条弯路，都实测踩过：
 * - 后台时传 `open={false}`：Base UI 关浮层要等退场动画的 effect 跑完才卸掉 portal，而后台 tab 的
 *   effect 已经被 `<Activity>` 销毁了 —— 那个「已经关掉」的抽屉一直留在屏幕上
 * - 后台时整个不渲染：挡不住了，但切一下 tab，填了一半的发起表单、写好的审批意见全没了（独立审查发现）
 *
 * 🔴 **三个值三个意思，`null` 和 `undefined` 不能混**：
 *
 * | 值 | 意思 | 交给 Base UI 的 `container` 之后 |
 * |---|---|---|
 * | 元素 | 在 tab 里，根节点就绪 | 挂进这个 tab |
 * | `null` | 在 tab 里，根节点**还没拿到**（`TabFrame` 第一次渲染） | **等**：Base UI 对显式 `null` 的约定是「容器还没好」，先不挂 |
 * | `undefined` | **不在任何 tab 里**（铃铛这类外壳家具） | 回落 `<body>` |
 *
 * 原来 context 的默认值是 `null`：同一个读者抽屉放到铃铛里（#186），`open` 是 true、
 * DOM 里**一个节点都没有**，不报错不警告 —— Base UI 一直在「等容器」（`FloatingPortal.js`：
 * `Wait for the container to be resolved if explicitly null`）。
 */
const TabContainerContext = React.createContext<HTMLElement | null | undefined>(undefined)

export function useTabPortalContainer(): HTMLElement | null | undefined {
  return React.useContext(TabContainerContext)
}

/**
 * @param escalate 哪些渲染异常**不**就地拦在这一页、照旧往上抛给路由的全局错误页。
 *   给「整个前端都不对了」的那几种用（发了新版、分片取不到）：那不是这一页的问题，
 *   就地显示只会让人一页页地点「重新加载」。判据在 app 层（`apps/web` 的 `isStaleAssetError`），
 *   shell 不认识它，所以从外面传进来
 */
export function TabOutlet({ registry, escalate }: { registry: PageRegistry; escalate?: (error: unknown) => boolean }) {
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
              escalate={escalate}
            />
          </Activity>
        )
      })}
    </>
  )
}

/** 地址的路径部分（去掉 `?search` 和 `#hash`）—— 页签的 href 和路由的 location.href 用同一种切法比 */
function pathOf(href: string): string {
  return href.split(/[?#]/)[0] ?? href
}

function TabFrame({
  tabKey, visible, href, params, search, Page, navigate, escalate,
}: {
  tabKey: string
  visible: boolean
  href: string
  params: unknown
  search: unknown
  Page: ComponentType<any>
  navigate: ReturnType<typeof useNavigate>
  escalate?: (error: unknown) => boolean
}) {
  const router = useRouter()
  const pathname = React.useMemo(() => pathOf(href), [href])
  // 用 state 不用 ref：子树要在拿到节点后重新渲染一次，才能把 portal 挂进来。
  // 🔴 回调里**忽略 null**：`<Activity>` 隐藏时会把 ref 解绑（传 null），而那个 DOM 节点其实还在。
  // 跟着置 null 的话 portal 目标变回 <body>、浮层整个重挂 —— 实测切回来表单是空的
  const [container, setContainer] = React.useState<HTMLElement | null>(null)
  const keepContainer = React.useCallback((el: HTMLElement | null) => {
    if (el) setContainer(el)
  }, [])

  // 页面改筛选/分页 → 写进 URL（视图状态的持久层，刷新后可恢复）
  //
  // 🔴 **只有前台页签才能写地址栏**（#405）。不少调用点是「await 完请求再写 URL」（审批的同意 / 退回、
  // 发起审批、AI 对话、角色 / 字典保存后关抽屉）：点完立刻切去别的页，请求回来时这一页已经在后台，
  // 原来照样 `navigate({ to: 本页 })` —— 用户被拽回来，`replace: true` 还把刚切过去的那条历史覆盖掉了。
  // 后台页签的变更只写进 tab-store（快照 + href），切回来时按新 href 导航，URL 自然跟上。
  //
  // 「在前台」按调用那一刻判，两件事都要成立，**不能用渲染时的 `visible`**（回调是请求回来时才调的）：
  //   - `activeKey` 是这一页
  //   - 路由的 `location` 也还在这一页 —— 点了侧边栏、导航还没走完时 `activeKey` 要等 idle 才换
  //     （`use-sync-tabs.ts`），只看它的话那个窗口里照样会把正在进行的导航顶回来
  const onSearchChange = React.useCallback(
    (next: Record<string, unknown>) => {
      const clean = Object.fromEntries(
        Object.entries(next).filter(([, v]) => v !== undefined && v !== '' && v !== null)
      )
      const store = useTabStore.getState()
      const front = store.activeKey === tabKey && pathOf(router.state.location.href) === pathname
      if (front) {
        void navigate({ to: pathname as never, search: clean as never, replace: true })
        return
      }
      // 用路由自己的序列化拼 href：雪花 ID 那套自定义 stringify（`lib/search-params.ts`）照样生效
      const nextHref = router.buildLocation({ to: pathname as never, search: clean as never }).href
      store.setSearch(tabKey, clean, nextHref)
    },
    [navigate, router, pathname, tabKey]
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
      ref={keepContainer}
      data-tab={tabKey}
      data-visible={visible}
      className="flex min-w-0 flex-1 flex-col content-scroll:min-h-0"
    >
      <TabContainerContext.Provider value={container}>
        {/* 每个页签一道错误边界：一页渲染抛错只换掉这一页，别的页签（含后台未保存的表单）不受影响。
            TabFrame 的 key 带 revision，「重新加载此页」换 key 时边界跟着重建，错误状态自然清掉 */}
        <TabErrorBoundary escalate={escalate} fallback={(error) => <TabCrash tabKey={tabKey} error={error} />}>
          <Page params={params} search={search} onSearchChange={onSearchChange} />
        </TabErrorBoundary>
      </TabContainerContext.Provider>
    </div>
  )
}

/**
 * 页签级错误边界（#405）。
 *
 * 🔴 原来所有页签（含隐藏的）都渲染在同一个 `_auth` 匹配下，任一页抛渲染异常，整屏换成路由的 500，
 * 其它页签未保存的状态全丢。而页签列表存在 sessionStorage：整页重载后出错的那页原样恢复、
 * 在后台再渲染一次 —— 异常由数据决定时，这个浏览器标签页里就再也出不来了（只能关浏览器标签页）。
 *
 * `escalate` 判为真的照旧往上抛（在 render 里重新 throw，交给外层的路由错误边界）。
 */
type BoundaryProps = {
  children: React.ReactNode
  fallback: (error: unknown) => React.ReactNode
  escalate?: (error: unknown) => boolean
}

export class TabErrorBoundary extends React.Component<BoundaryProps, { failed: boolean; error: unknown }> {
  state = { failed: false, error: undefined as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  render() {
    if (!this.state.failed) return this.props.children
    if (this.props.escalate?.(this.state.error)) throw this.state.error
    return this.props.fallback(this.state.error)
  }
}

function TabCrash({ tabKey, error }: { tabKey: string; error: unknown }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const actions = useTabActions()
  const tab = useTabStore((s) => s.tabs.find((x) => x.key === tabKey))
  // 「重试」= 重新加载此页，但光重挂不够：异常多半是数据决定的，那份数据还在查询缓存里，
  // 重挂时先读到缓存、再炸一次（E2E 第一版就红在这）。出错这页的观察者已经随它卸载，
  // 所以清掉不活跃的查询；代价是后台页签的缓存一起清了，切回去时重新取一次
  const retry = () => {
    qc.removeQueries({ type: 'inactive' })
    actions.reload(tabKey)
  }
  return (
    <div className="flex flex-col gap-3 p-4 md:p-6" data-testid="tab-crash">
      <QueryError
        error={error}
        title={t('这一页出错了')}
        detail={error instanceof Error ? error.message : undefined}
        onRetry={retry}
        testId="tab-crash-error"
      />
      {tab && isRemovable(tab) && (
        <div>
          <Button variant="outline" size="sm" onClick={() => actions.close(tabKey)} data-testid="tab-crash-close">
            {t('关闭此页')}
          </Button>
        </div>
      )}
    </div>
  )
}
