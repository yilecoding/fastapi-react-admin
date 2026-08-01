import type { AnyRouter } from "@tanstack/react-router"

/**
 * 前端真实存在的路由 path 集合（运行时）。
 *
 * 后端菜单表是独立维护的，`path` 填错在 Vue 那套里会白屏；
 * 这里把它降级成「侧边栏跳过 + 开发期告警」。
 *
 * 数据来源是 router 实例的 `routesByPath`（键就是 fullPath）。
 * 注意 `flatRoutes` 在 TanStack Router 1.170 上不存在 —— 实测确认。
 *
 * 类型层的对应物是 routeTree.gen.ts 的 `FileRoutesByTo`，
 * 菜单管理页的 path 下拉选项应当由它生成 —— 那样连填错的机会都没有。
 */
export function buildValidPaths(router: AnyRouter): Set<string> {
  const r = router as unknown as {
    routesByPath?: Record<string, unknown>
    routesById?: Record<string, unknown>
  }
  const paths = new Set<string>()

  const norm = (p: string) => p.replace(/\/+$/, "") || "/"

  for (const p of Object.keys(r.routesByPath ?? {})) paths.add(norm(p))

  // 兜底：从 routesById 反推（去掉 pathless layout 段，如 /_auth）
  if (paths.size <= 1) {
    for (const id of Object.keys(r.routesById ?? {})) {
      if (id === "__root__") continue
      const p = id
        .split("/")
        .filter((seg) => seg && !seg.startsWith("_"))
        .join("/")
      paths.add(norm("/" + p))
    }
  }

  return paths
}

export function makeIsValidPath(router: AnyRouter) {
  let cache: Set<string> | null = null
  return (path: string) => {
    cache ??= buildValidPaths(router)
    return cache.has(path.replace(/\/+$/, "") || "/")
  }
}
