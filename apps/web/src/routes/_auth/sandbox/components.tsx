import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireAuth } from "@admin/platform/auth/guards"

/**
 * 组件沙箱。只要登录就能进，不挂业务权限码 —— 它不碰任何业务数据。
 * 露不露出来由参数配置的 DEV 组决定（见 pages/dev-sandbox/api.ts）。
 */
const searchSchema = z.object({
  /** 当前组件 */
  c: z.string().optional(),
  /** 搜索词 */
  q: z.string().optional(),
})

export const Route = createFileRoute("/_auth/sandbox/components")({
  validateSearch: searchSchema,
  beforeLoad: requireAuth,
  staticData: { title: "组件沙箱" },
  component: () => null,
})
