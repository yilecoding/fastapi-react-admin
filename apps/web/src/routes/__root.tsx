import * as React from "react"
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router"
import type { QueryClient } from "@tanstack/react-query"

import { ErrorPage } from "@/routes/-error"

const TanStackRouterDevtools = import.meta.env.DEV
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
      {import.meta.env.DEV && (
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
