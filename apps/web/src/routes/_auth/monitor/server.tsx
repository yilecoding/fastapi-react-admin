import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireSuperUser } from "@admin/platform/auth/guards"

/**
 * 服务器监控。后端 `GET /monitors/server` 是 `DependsSuperUser`，
 * 菜单表里这条的 `perms` 是空串 —— 所以守卫走「超管」而不是权限码。
 */
const searchSchema = z.object({
  /** 自动刷新间隔（秒），0 = 手动 */
  refresh: z.coerce.number().int().min(0).max(3600).optional(),
})

export const Route = createFileRoute("/_auth/monitor/server")({
  validateSearch: searchSchema,
  beforeLoad: requireSuperUser(),
  staticData: { title: "服务器监控" },
  component: () => null,
})
