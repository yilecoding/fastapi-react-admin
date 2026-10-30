import { createFileRoute } from "@tanstack/react-router"

import { requirePerm } from "@admin/platform/auth/guards"

export const Route = createFileRoute("/_auth/notify/bot")({
  beforeLoad: requirePerm("sys:notification:bot:list"),
  staticData: { title: "群机器人" },
  component: () => null,
})
