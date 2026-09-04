import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  IconChevronLeft, IconChevronRight, IconDotsVertical, IconRefresh,
} from '@tabler/icons-react'

import { Button } from '@admin/ui/components/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@admin/ui/components/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@admin/ui/components/tooltip'
import { cn } from '@admin/ui/lib/utils'

import { usePlatform } from './platform-context'
import { usePreferences, type TabStyle } from './preferences'
import { TabItem } from './tab-item'
import { TabListMenu } from './tab-list-menu'
import { TabMenu, type TabMenuTarget } from './tab-menu'
import { isRemovable, useTabStore } from './tab-store'
import { useSidebar } from './use-sidebar'
import { tabCapabilities, useTabActions } from './use-tab-actions'

/**
 * 多页签标签条。
 *
 * 组成（各自一个文件，这里只做编排）：
 *   `tab-item.tsx`        单个 tab —— 左键切换 / 中键关闭 / × / 固定态
 *   `tab-menu.tsx`        右键菜单 —— 关闭 · 固定 · 重新加载 · 新窗口 · 左/右/其它/全部
 *   `use-tab-actions.ts`  动作层 —— 「改 store + 跳到哪个 tab」成对出现，三处复用
 *   `tab-store.ts`        状态 —— sessionStorage 持久化，固定的排在最前
 *
 *   `tab-list-menu.tsx`   总览下拉 —— 全部 tab 一次看全，点一行跳过去
 *   `preferences.ts`      外壳偏好 —— 显示/外观/中键关闭/图标/拖拽排序
 *
 * 本文件负责三件事：
 * 1. 横向溢出：滚动容器 + 两侧滚动按钮 + 滚轮横滚（对照过 Vben 的 « » 手感）
 *
 *    ⚠️ 滚动容器必须带 `min-w-0`。flex 子项的 `min-width` 默认是 `auto`
 *    （= 内容宽度），不给 `min-w-0` 的话它不肯收缩，`overflow-x-auto` 形同虚设：
 *    tab 会一路溢出到视口外、把右侧工具区也挤出去，而 `scrollWidth === clientWidth`
 *    让「是否溢出」永远判为 false，滚动按钮也就永远不出现。实测踩过。
 *
 * 2. 活动 tab 自动滚入可见区 —— **测量范围限定在 `listRef` 内**。
 *    隐藏 tab 的 DOM 仍在文档树里，`document.querySelector` 会命中它们（见 CLAUDE.md 第 5 条）
 * 3. 右侧工具区：总览下拉（带数量）+ 重新加载当前页 + 「更多」菜单
 */
/**
 * 不同外观对**容器**的要求不同：
 * 卡片/按钮/柔和是「独立小块」，需要 gap + 上下留白（阴影要地方画）；
 * 下划线是「贴齐底边的一整排」，不能有 gap 和上下留白，否则线断开、也压不到底边。
 */
const LIST_STYLE: Record<TabStyle, string> = {
  card: 'gap-1 px-0.5 py-1',
  button: 'gap-1 px-0.5 py-1',
  soft: 'gap-1 px-0.5 py-1',
  underline: 'gap-0 px-0.5',
}

export function TabBar() {
  const { t } = useTranslation()
  const tabs = useTabStore((s) => s.tabs)
  const activeKey = useTabStore((s) => s.activeKey)
  const act = useTabActions()
  const showTabs = usePreferences((s) => s.showTabs)
  const tabStyle = usePreferences((s) => s.tabStyle)
  const tabShowIcon = usePreferences((s) => s.tabShowIcon)
  const middleClickClose = usePreferences((s) => s.tabMiddleClickClose)
  const tabDraggable = usePreferences((s) => s.tabDraggable)
  const reorder = useTabStore((s) => s.reorder)

  // 拖拽排序的过程态：谁在被拖、当前悬停在谁的哪一侧
  const [drag, setDrag] = React.useState<{ from: string; over?: string; side?: 'start' | 'end' } | null>(null)

  const [menuTarget, setMenuTarget] = React.useState<TabMenuTarget | null>(null)

  // tab 图标复用侧边栏菜单树里的（同一份 query 缓存，不会多打一次请求）
  const { isValidPath } = usePlatform()
  const sidebarOpts = React.useMemo(() => ({ isValidPath }), [isValidPath])
  const { nav } = useSidebar(sidebarOpts)
  const iconByPath = React.useMemo(() => {
    const map = new Map<string, string | null>()
    const walk = (nodes: typeof nav) => {
      for (const n of nodes) {
        if (n.path) map.set(n.path, n.icon)
        walk(n.children)
      }
    }
    walk(nav)
    return map
  }, [nav])

  // ── 横向溢出 ──
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = React.useState({ left: false, right: false })

  const measure = React.useCallback(() => {
    const el = listRef.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    // 1px 容差：缩放比例下 scrollWidth/clientWidth 会差出小数
    setOverflow({ left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 })
  }, [])

  React.useEffect(() => {
    const el = listRef.current
    if (!el) return
    measure()
    // 容器变宽变窄、tab 增减都要重算 —— 只监听 window resize 会漏掉侧边栏折叠
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    return () => ro.disconnect()
    // showTabs 必须在依赖里：偏好关掉多标签页时下面 `return null`，listRef 拿到的是
    // null，effect 空手退出；只靠 tabs.length 触发不会补跑（关闭再打开标签条时
    // tabs.length 通常没变）。同一个坑见下面滚轮监听那条注释。
  }, [measure, showTabs, tabs.length])

  // 滚轮横滚：鼠标在标签条上滚，意图是左右翻 tab 而不是滚页面。
  // 必须手动注册非 passive 监听 —— React 的 onWheel 是 passive 的，
  // 里面调 preventDefault 无效，控制台还会刷 "Unable to preventDefault" 告警。
  React.useEffect(() => {
    const el = listRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX
      if (delta === 0) return
      e.preventDefault()
      el.scrollLeft += delta
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // 依赖不能是 []：TabBar 本身不会因为 showTabs 变化而重新挂载（下面只是
    // `return null`，函数组件实例还在），[] 意味着这个 effect 只在**首次**
    // commit 时跑一次。如果那一刻 showTabs 恰好是 false，listRef.current 是
    // null，监听器永远绑不上；之后把 showTabs 切回 true，标签条重新出现，
    // 但滚轮横滚已经废了（组件没有重新 mount，effect 不会重跑）。实测踩过。
  }, [showTabs, tabs.length])

  // 活动 tab 滚入可见区（切页、或活动 tab 因关闭而变化时）
  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [activeKey, tabs.length, measure])

  const scrollBy = (delta: number) =>
    listRef.current?.scrollBy({ left: delta, behavior: 'smooth' })

  // 只在真的被裁的那一侧渐隐 —— 两端都不溢出时不加 mask（mask 会吃掉 1px 边框的锐度）
  const fadeMask = React.useMemo<React.CSSProperties>(() => {
    if (!overflow.left && !overflow.right) return {}
    // 12px：够把切一半的字淡掉，又不会吃掉贴边 tab 的 1px 边框
    const stops = [
      overflow.left ? 'transparent 0, black 12px' : 'black 0',
      overflow.right ? 'black calc(100% - 12px), transparent 100%' : 'black 100%',
    ].join(', ')
    return { maskImage: `linear-gradient(to right, ${stops})` }
  }, [overflow.left, overflow.right])

  // 偏好里关掉多标签页 → 整条不渲染（页面仍由 TabOutlet 挂载，只是没有这条导航）
  if (!showTabs || !tabs.length) return null

  const activeCap = activeKey ? tabCapabilities(tabs, activeKey) : null
  const anyRemovable = tabs.some(isRemovable)

  return (
    <div
      // 这里**不能** overflow-hidden：活动 tab 的 shadow-sm 会被贴边裁掉。
      // 横向溢出真正的解法是 SidebarInset 的 min-w-0（见 CLAUDE.md），不是在这层裁。
      // 上下留白交给内部滚动容器（见下面的 py-1），阴影才有地方画。
      className={cn(
        // shrink-0：内容区滚动模式下外壳是 h-svh 的列向 flex，
        // 不写它标签条会被内容挤扁（tab 的上下留白先被吃掉，看着像「行高变了」）
        'flex min-w-0 shrink-0 items-center gap-1 border-b border-border bg-muted/30 px-2',
        // 下划线风格：tab 要贴到底边，整条给个固定高度让 self-stretch 有依据
        tabStyle === 'underline' && 'h-9'
      )}
      data-style={tabStyle}
      data-tour="tab-bar"
      data-testid="tab-bar"
    >
      {overflow.left && (
        <ScrollButton dir="start" onClick={() => scrollBy(-240)} />
      )}

      <div
        ref={listRef}
        onScroll={measure}
        // 两端渐隐：滚动时被裁到一半的 tab 淡出，而不是被生生切断
        style={fadeMask}
        // 三件事压在这一行上：
        //   min-w-0            —— 允许收缩，否则 overflow-x-auto 形同虚设
        //   LIST_STYLE 的 py-* —— 留白必须在**滚动容器内部**：overflow-x:auto 会让
        //                         overflow-y 也计算成 auto，贴边的 shadow-sm 会被裁掉
        //   scrollbar 藏起来   —— 这条是操作区不是内容区，滚动条会把 tab 挤矮
        //   （用 shadcn 上游的 `no-scrollbar` utility，别再手写 arbitrary properties：
        //    sidebar / command 用的是同一个，全站一种写法）
        className={cn(
          'no-scrollbar flex min-w-0 flex-1 items-center overflow-x-auto',
          LIST_STYLE[tabStyle]
        )}
        role="tablist"
      >
        {tabs.map((tab) => {
          const pathname = tab.href.split('?')[0] ?? tab.href
          return (
            <TabItem
              key={tab.key}
              tab={tab}
              active={tab.key === activeKey}
              icon={iconByPath.get(pathname)}
              closable={isRemovable(tab)}
              styleName={tabStyle}
              showIcon={tabShowIcon}
              middleClickClose={middleClickClose}
              draggable={tabDraggable}
              dragging={drag?.from === tab.key}
              dropSide={drag && drag.over === tab.key && drag.from !== tab.key ? drag.side : undefined}
              onDragStart={() => setDrag({ from: tab.key })}
              onDragOver={(side) =>
                setDrag((d) => (d && (d.over !== tab.key || d.side !== side) ? { ...d, over: tab.key, side } : d))
              }
              onDrop={() => {
                if (drag && drag.from !== tab.key) reorder(drag.from, tab.key)
                setDrag(null)
              }}
              onDragEnd={() => setDrag(null)}
              onActivate={() => act.activate(tab)}
              onClose={() => act.close(tab.key)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenuTarget({ key: tab.key, x: e.clientX, y: e.clientY })
              }}
            />
          )
        })}
      </div>

      {overflow.right && <ScrollButton dir="end" onClick={() => scrollBy(240)} />}

      {/* ── 右侧工具区 ── */}
      <div className="ms-1 flex shrink-0 items-center gap-0.5 border-s border-border ps-1.5">
        <TabListMenu
          tabs={tabs}
          activeKey={activeKey}
          iconByPath={iconByPath}
          onSelect={(tab) => act.activate(tab)}
          onClose={(key) => act.close(key)}
        />

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost" size="icon" className="size-7"
                aria-label={t("重新加载当前页")} data-testid="tab-reload"
                disabled={!activeKey}
                onClick={() => activeKey && act.reload(activeKey)}
              />
            }
          >
            <IconRefresh className="size-4" />
          </TooltipTrigger>
          <TooltipContent>{t('重新加载当前页')}</TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost" size="icon" className="size-7"
                aria-label={t("标签页操作")} data-testid="tab-actions"
              />
            }
          >
            <IconDotsVertical className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              disabled={!activeCap?.canPin}
              data-testid="tab-actions-pin"
              onClick={() => activeKey && act.togglePin(activeKey)}
            >
              {activeCap?.pinned ? t('取消固定当前页') : t('固定当前页')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!activeCap?.canCloseOthers}
              data-testid="tab-actions-close-others"
              onClick={() => activeKey && act.closeOthers(activeKey)}
            >
              {t('关闭其它标签页')}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!anyRemovable}
              variant="destructive"
              data-testid="tab-actions-close-all"
              onClick={() => act.closeAll()}
            >
              {t('关闭全部标签页')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <TabMenu target={menuTarget} onClose={() => setMenuTarget(null)} />
    </div>
  )
}

function ScrollButton({ dir, onClick }: { dir: 'start' | 'end'; onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      aria-label={dir === 'start' ? t('向左滚动标签页') : t('向右滚动标签页')}
      data-testid={`tab-scroll-${dir}`}
      onClick={onClick}
    >
      {dir === 'start' ? <IconChevronLeft className="size-4" /> : <IconChevronRight className="size-4" />}
    </Button>
  )
}
