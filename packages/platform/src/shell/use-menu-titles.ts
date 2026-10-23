import * as React from 'react'
import { useQuery } from '@tanstack/react-query'

import { sidebarQuery } from '../auth/queries'
import { MenuType, type SidebarNode } from '../api-client/sidebar-types'

/**
 * pathname → 库里的菜单标题。标签条 · 标签列表 · 命令面板的「已打开」用它，再交给 `menuTitle()`。
 *
 * 🔴 不能只用标签自己存的 `title`：那是打开那一刻定下的（路由 `staticData.title` 优先，见 `use-sync-tabs.ts`），
 * 管理员之后在菜单管理里改了名，侧边栏和面包屑跟着变，已经打开的标签不会（#143）。
 * 查不到的（个人中心、无权访问这类不在菜单里的页面）返回 `undefined`，由调用方回落到标签自己的标题。
 */
export function useMenuTitles(): (pathname: string) => string | undefined {
  const { data } = useQuery(sidebarQuery)
  const byPath = React.useMemo(() => {
    const map = new Map<string, string>()
    const walk = (nodes: SidebarNode[]) => {
      for (const n of nodes) {
        if (n.path && n.type !== MenuType.Button) map.set(n.path, n.meta.title)
        walk(n.children ?? [])
      }
    }
    walk(data ?? [])
    return map
  }, [data])
  return React.useCallback((pathname: string) => byPath.get(pathname), [byPath])
}
