import { createFileRoute } from "@tanstack/react-router"

import { requirePerm } from "@admin/platform/auth/guards"

export const Route = createFileRoute("/_auth/ai/mcp-client")({
  beforeLoad: requirePerm("ai:mcp:list"),
  staticData: { title: "MCP 凭据" },
  component: () => null,
})
