import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  title: z.string().optional(),
  status: z.coerce.number().int().optional(),
  type: z.coerce.number().int().optional(),
  /** 'all' = 树默认全折叠 */
  fold: z.literal("all").optional(),
  /** 只看死链 */
  broken: z.boolean().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/system/menu")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:menu:add"),
  staticData: { title: "菜单管理" },
  component: () => null,
})
