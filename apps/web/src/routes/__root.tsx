import * as React from "react"
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

import { ErrorPage } from "@/routes/-error"

// 默认不挂开发浮窗，避免右下角徽标和展开面板遮挡业务界面。
// 排查路由时用 `VITE_ROUTER_DEVTOOLS=true pnpm --filter web dev` 临时开启。
const routerDevtoolsEnabled =
  import.meta.env.DEV && import.meta.env.VITE_ROUTER_DEVTOOLS === "true"

const TanStackRouterDevtools = routerDevtoolsEnabled
  ? React.lazy(() =>
      import("@tanstack/router-devtools").then((m) => ({ default: m.TanStackRouterDevtools }))
    )
  : () => null

export type RouterContext = {
  queryClient: QueryClient
}

function RootComponent() {
  return (
    <>
      <Outlet />
      {routerDevtoolsEnabled && (
        <React.Suspense>
          <TanStackRouterDevtools position="bottom-right" />
        </React.Suspense>
      )}
    </>
  )
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: ErrorPage,
})
