import { createFileRoute } from "@tanstack/react-router"

import { requirePerm } from "@admin/platform/auth/guards"

export const Route = createFileRoute("/_auth/sms/config")({
  beforeLoad: requirePerm("sms:config:list"),
  staticData: { title: "短信配置" },
  component: () => null,
})
