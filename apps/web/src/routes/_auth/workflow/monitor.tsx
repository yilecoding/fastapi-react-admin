import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  keyword: z.string().optional(),
  status: z.enum(["running", "approved", "rejected", "withdrawn", "terminated"]).optional(),
  id: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/workflow/monitor")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("workflow:instance:list"),
  staticData: { title: "实例监控" },
  component: () => null,
})
