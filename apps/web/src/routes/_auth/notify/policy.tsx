import { createFileRoute } from "@tanstack/react-router"

import { requirePerm } from "@admin/platform/auth/guards"

export const Route = createFileRoute("/_auth/notify/policy")({
  beforeLoad: requirePerm("sys:notification:policy:list"),
  staticData: { title: "通知策略" },
  component: () => null,
})
