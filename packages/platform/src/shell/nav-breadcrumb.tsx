import * as React from "react"
import { menuKey } from "@admin/i18n"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@admin/ui/components/breadcrumb"

import type { NavNode } from "./use-sidebar"

/** activePath 在导航树里的祖先链（含它自己）,找不到返回 null —— 调用方回退到 fallbackTitle */
function findChain(nodes: NavNode[], path: string, trail: NavNode[] = []): NavNode[] | null {
  for (const node of nodes) {
    const next = [...trail, node]
    if (node.path === path) return next
    const hit = findChain(node.children, path, next)
    if (hit) return hit
  }
  return null
}

/**
 * 顶栏面包屑：走的是后端菜单树的祖先链,不是路由文件系统的目录结构 ——
 * 两者不一定一致（`/system/user` 的父级是菜单表里的「系统管理」分组,
 * 不是一个真实存在的 `/system` 页面,点不进去)。
 *
 * `hideInMenu` 的页面(比如「个人中心」)根本不进 `nav` 树,链找不到时
 * 退回 `fallbackTitle`（调用方传当前 tab 自己的标题)单独顶一级,不留白。
 */
export function NavBreadcrumb({
  nav,
  activePath,
  fallbackTitle,
}: {
  nav: NavNode[]
  activePath: string
  fallbackTitle?: string
}) {
  const { t } = useTranslation()
  const chain = findChain(nav, activePath)

  if (!chain) {
    if (!fallbackTitle) return null
    return (
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="flex-nowrap">
          <BreadcrumbItem className="min-w-0">
            <BreadcrumbPage className="truncate">{fallbackTitle}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    )
  }

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {chain.map((node, i) => {
          const isLast = i === chain.length - 1
          const label = t(menuKey(node.path), { defaultValue: t(node.title) })
          // 分组节点(有子级)本身进不去,和叶子的当前页一样只展示文字、不做链接
          const asPage = isLast || node.children.length > 0
          return (
            <React.Fragment key={node.id}>
              <BreadcrumbItem className="min-w-0">
                {asPage ? (
                  <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink render={<Link to={node.path as never} />} className="truncate">
                    {label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </React.Fragment>
          )
        })}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
