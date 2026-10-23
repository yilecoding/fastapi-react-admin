import { createFileRoute, redirect } from "@tanstack/react-router"

/**
 * 一律去仪表盘，由那里的守卫决定「静默恢复」还是「去登录页」（`requireAuth`）。
 *
 * access token 只在内存里（#138），刷新页面之后这里手里没有 token —— 原来按
 * `isAuthenticated()` 分流的话，一个会话好好的人刷新一下首页就被送到登录页
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" })
  },
})
