import { createFileRoute } from "@tanstack/react-router"

import { requirePerm } from "@admin/platform/auth/guards"

export const Route = createFileRoute("/_auth/system/storage")({
  beforeLoad: requirePerm("sys:storage:list"),
  staticData: { title: "存储管理" },
  component: () => null,
})
