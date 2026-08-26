import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireSuperUser } from "@admin/platform/auth/guards"

/**
 * Redis 监控。后端 `GET /monitors/redis` 是 `DependsSuperUser`——之前误配成
 * `DependsJwtAuth`，跟同组的 `/monitors/server`、`/monitors/sessions` 门槛不一致
 * （任何登录用户都能读到 Redis 实例信息），2026-08-26 对齐（见 issue #30）。
 */
const searchSchema = z.object({
  refresh: z.coerce.number().int().min(0).max(3600).optional(),
  /** 命令统计的搜索词 */
  cmd: z.string().optional(),
  /** 1 = 命令统计展开全部 */
  all: z.coerce.number().int().min(0).max(1).optional(),
})

export const Route = createFileRoute("/_auth/monitor/redis")({
  validateSearch: searchSchema,
  beforeLoad: requireSuperUser(),
  staticData: { title: "Redis 监控" },
  component: () => null,
})
