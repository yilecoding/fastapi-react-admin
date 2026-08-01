import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { isAuthenticated } from "@admin/platform/auth/session"

/** 已登录访问登录页 → 踢回工作区 */
export const Route = createFileRoute("/_guest")({
  beforeLoad: () => {
    if (isAuthenticated()) throw redirect({ to: "/dashboard" })
  },
  component: () => <Outlet />,
})
