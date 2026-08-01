import { createRouter } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

import { routeTree } from "@/routeTree.gen"
import { parseSearch, stringifySearch } from "@/lib/search-params"
import { ErrorPage } from "@/routes/-error"
import { NotFoundPage } from "@/routes/-404"

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    // 默认的 JSON.parse 会把雪花 ID 截断成另一个数字 —— 见 lib/search-params.ts
    parseSearch,
    stringifySearch,
    defaultPreload: "intent",
    scrollRestoration: true,
    defaultNotFoundComponent: NotFoundPage,
    // TanStack 的错误不冒泡到父路由，必须设 default 才能兜住每个 route
    defaultErrorComponent: ErrorPage,
    notFoundMode: "root",
  })
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
