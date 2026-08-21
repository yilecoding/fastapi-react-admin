import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireAuth } from "@admin/platform/auth/guards"

/**
 * Redis 监控。后端 `GET /monitors/redis` 只要 `DependsJwtAuth`（不限超管），
 * 所以这里只做登录校验。
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
  beforeLoad: requireAuth,
  staticData: { title: "Redis 监控" },
  component: () => null,
})
