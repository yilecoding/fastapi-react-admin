import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 键 = `pages/open-app` 里 `FIELDS` 的 `key` */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  name: z.string().optional(),
  /** 1 正常 · 0 停用 · 2 已过期（过期由后端按失效时间算） */
  status: z.coerce.number().int().optional(),
  f: z.string().optional(),
  hide: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/open/app")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("open:app:list"),
  staticData: { title: "应用管理" },
  component: () => null,
})
