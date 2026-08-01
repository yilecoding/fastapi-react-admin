import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  name: z.string().optional(),
  status: z.coerce.number().int().optional(),
  /** 'all' = 树默认全折叠 */
  fold: z.literal("all").optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/system/dept")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:dept:add"),
  staticData: { title: "部门管理" },
  component: () => null,
})
