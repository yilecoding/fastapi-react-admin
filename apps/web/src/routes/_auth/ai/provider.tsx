import { createFileRoute } from "@tanstack/react-router"

import { requirePerm } from "@admin/platform/auth/guards"

export const Route = createFileRoute("/_auth/ai/provider")({
  beforeLoad: requirePerm("ai:provider:list"),
  staticData: { title: "模型密钥管理" },
  component: () => null,
})
