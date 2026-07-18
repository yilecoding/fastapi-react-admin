import type { ReactNode } from 'react'
import { menuKey } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { IconChevronRight, IconExternalLink } from '@tabler/icons-react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@admin/ui/components/collapsible'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@admin/ui/components/sidebar'
import { Skeleton } from '@admin/ui/components/skeleton'

import { MenuIcon } from './icon-registry'
import { useSidebar, type NavNode, type SidebarOptions } from './use-sidebar'

/**
 * 侧边栏节点。
 *
 * ⚠️ 同一层级必须用同一套组件，否则会错位：
 * 顶层用 `SidebarMenuItem` + `SidebarMenuButton`，
 * 子层用 `SidebarMenuSubItem` + `SidebarMenuSubButton`（两者内边距不同）。
 * 之前「有子项的子菜单」误用了顶层组件 + 额外 ps-1，
 * 导致「数据权限」比同级的「菜单管理」「数据字典」多缩进一截。
 */
function NavItem({
  node,
  activePath,
  nested = false,
}: {
  node: NavNode
  activePath: string
  nested?: boolean
}) {
  const { t } = useTranslation()
  const hasChildren = node.children.length > 0
  const isActive = node.path === activePath
  const containsActive = React.useMemo(
    () => hasChildren && subtreeHasPath(node, activePath),
    [node, activePath, hasChildren]
  )

  // 受控展开：菜单树是异步到达的，用 defaultOpen 会触发
  // 「uncontrolled → controlled」警告，且首次渲染时 containsActive 还是 false。
  // 用户手动折叠后不再被 activePath 强行拉开。
  const [open, setOpen] = React.useState(containsActive)
  const touched = React.useRef(false)
  React.useEffect(() => {
    if (!touched.current && containsActive) setOpen(true)
  }, [containsActive])

  const Item = nested ? SidebarMenuSubItem : SidebarMenuItem
  const ItemButton = nested ? SidebarMenuSubButton : SidebarMenuButton
  const iconClass = nested ? 'size-3.5' : undefined

  // ── 叶子节点 ──
  if (!hasChildren) {
    if (node.external) {
      return (
        <Item>
          <ItemButton render={<a href={node.external} target="_blank" rel="noreferrer" />}>
            <MenuIcon name={node.icon} className={iconClass} />
            <span>{t(menuKey(node.path), { defaultValue: t(node.title) })}</span>
            <IconExternalLink className="ms-auto size-3 opacity-50" />
          </ItemButton>
        </Item>
      )
    }
    return (
      <Item>
        <ItemButton
          isActive={isActive}
          data-testid={`nav-${node.path}`}
          render={<Link to={node.path as never} />}
        >
          <MenuIcon name={node.icon} className={iconClass} />
          <span>{t(menuKey(node.path), { defaultValue: t(node.title) })}</span>
        </ItemButton>
      </Item>
    )
  }

  // ── 可展开分组 ──
  return (
    <Collapsible
      open={open}
      onOpenChange={(o) => {
        touched.current = true
        setOpen(o)
      }}
      className="group/collapsible"
    >
      <Item>
        <CollapsibleTrigger render={<ItemButton data-testid={`nav-group-${node.title}`} />}>
          <MenuIcon name={node.icon} className={iconClass} />
          <span>{t(menuKey(node.path), { defaultValue: t(node.title) })}</span>
          <IconChevronRight className="ms-auto size-4 shrink-0 transition-transform group-data-[panel-open]/collapsible:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {node.children.map((c) => (
              <NavItem key={c.id} node={c} activePath={activePath} nested />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Item>
    </Collapsible>
  )
}

function subtreeHasPath(node: NavNode, path: string): boolean {
  if (node.path === path) return true
  return node.children.some((c) => subtreeHasPath(c, path))
}

/**
 * `mark` 和 `title` 走 props 注入：品牌标识属于应用，platform 不能反向
 * import apps/web（依赖方向单向）。不传就退化成标题首字的方块。
 */
export function AppSidebar({
  options,
  title,
  mark,
}: {
  options: SidebarOptions
  title?: string
  mark?: ReactNode
}) {
  const { t } = useTranslation()
  // 默认标题不能写进参数默认值 —— 默认值在 hook 之前求值，调不了 t()
  const label = title ?? t('管理平台')
  const { nav, isPending } = useSidebar(options)
  const activePath = useRouterState({ select: (s) => s.location.pathname })

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        {/*
          折叠态必须去掉内层 `px-2` 并改成居中，否则 logo 比下面的导航图标右偏 6px。
          rail 宽 48px（`--sidebar-width-icon`），两边的居中基准本来不一样：
            导航图标：SidebarGroup 的 p-2(8) + 按钮折叠成 size-8(32) → 8~40，中心 24 ✓
            logo    ：SidebarHeader 的 p-2(8) + 这里的 px-2(8) + size-7(28) → 16~44，中心 30 ✗
          px-0 + justify-center 后 logo 落在 10~38，中心也是 24，与导航图标对齐。
          （`px-2` 和 `group-data-*:px-0` 变体作用域不同，twMerge 不会互相消解 ——
           两条都会留在 class 里，靠属性选择器的特异性让折叠态那条胜出，这是想要的。）
        */}
        <div className="flex items-center gap-2 px-2 py-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
            {mark ?? label.slice(0, 1)}
          </div>
          <span className="truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">{label}</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu data-testid="sidebar-nav">
            {isPending
              ? Array.from({ length: 5 }).map((_, i) => (
                  <SidebarMenuItem key={i}>
                    <Skeleton className="h-8 w-full" />
                  </SidebarMenuItem>
                ))
              : nav.map((n) => <NavItem key={n.id} node={n} activePath={activePath} />)}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
