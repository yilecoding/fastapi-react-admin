import { menuTitle } from '@admin/i18n'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import { IconBolt } from '@tabler/icons-react'

import { MenuIcon } from '../../../shell/icon-registry'
import type { NavNode } from '../../../shell/use-sidebar'
import { DashboardCard } from '../card-shell'
import type { CardProps } from './types'

/** 没挑过的人默认放侧边栏里的前几个页面 */
export const QUICK_LINKS_DEFAULT = 6

/**
 * 侧边栏 → 能当快捷入口的页面（叶子、站内、不是工作台自己），按侧边栏顺序，path 去重。
 *
 * 候选**只从这个人自己的侧边栏里来**：侧边栏已经按他的权限、菜单的停用、前端有没有这个路由过滤过一遍
 * （`use-sidebar.ts: toNavTree`），这里不再自己判一次权限 —— 两处各判一份迟早漂移
 */
export function flattenPages(nav: NavNode[]): NavNode[] {
  const out: NavNode[] = []
  const seen = new Set<string>()
  const walk = (nodes: NavNode[]) => {
    for (const n of nodes) {
      if (n.children.length) walk(n.children)
      else if (n.path && !n.external && n.path !== '/dashboard' && !seen.has(n.path)) {
        seen.add(n.path)
        out.push(n)
      }
    }
  }
  walk(nav)
  return out
}

/**
 * 挑过的 path → 现在还能去的页面。
 *
 * 存的 path 现在不在侧边栏里了（权限收回 / 菜单停用 / 页面删了）→ 不画，**不**替他从存的里删掉：
 * 权限还回来时它照旧出现（同卡片布局「现在不能用的原样带回去」那条）
 */
export function resolveQuickLinks(quickLinks: string[] | null, pages: NavNode[]): NavNode[] {
  if (quickLinks === null) return pages.slice(0, QUICK_LINKS_DEFAULT)
  const byPath = new Map(pages.map((p) => [p.path, p]))
  return quickLinks.map((p) => byPath.get(p)).filter((p): p is NavNode => Boolean(p))
}

/**
 * 「快捷入口」卡：点一个就开对应的页签。
 *
 * 用 `<Link>` 不用 `useNavigate()`（硬纪律 1）：`<Link>` 走 router context，隐藏的 tab 里照样能用；
 * 落地之后 `useSyncTabs` 按 location 开 / 切页签，和点侧边栏是同一条路
 */
export function QuickLinksCard({ quickLinks, pages }: CardProps) {
  const { t } = useTranslation()
  const links = resolveQuickLinks(quickLinks, pages)

  return (
    <DashboardCard
      testId="dash-quick-links"
      title={t('快捷入口')}
      icon={<IconBolt className="size-4 text-primary" aria-hidden />}
      empty={links.length === 0}
      emptyText={t('还没有快捷入口。点「编辑工作台」，从你的菜单里挑几个常用页面。')}
    >
      <ul className="grid grid-cols-2 gap-2 @xl/main:grid-cols-3 @5xl/main:grid-cols-6">
        {links.map((p) => (
          <li key={p.path} className="min-w-0">
            <Link
              to={p.path as never}
              className="flex h-full flex-col items-center gap-1.5 rounded-md border border-border/60 px-2 py-3 text-center text-sm transition-colors hover:border-primary/40 hover:bg-muted/40"
              data-testid={`dash-quick-link-${p.path}`}
            >
              <MenuIcon name={p.icon} className="size-5 text-muted-foreground" />
              <span className="w-full truncate">{menuTitle(t, p.path, p.title)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </DashboardCard>
  )
}
