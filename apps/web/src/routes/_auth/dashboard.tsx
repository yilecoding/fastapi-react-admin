import { createFileRoute } from "@tanstack/react-router"

/**
 * 页面组件不在这里渲染 —— 由 TabOutlet 统一挂载（见 _auth.tsx）。
 * 这里只负责：search schema、staticData、权限守卫。
 */
export const Route = createFileRoute("/_auth/dashboard")({
  staticData: { title: "仪表盘" },
  component: () => null,
})
