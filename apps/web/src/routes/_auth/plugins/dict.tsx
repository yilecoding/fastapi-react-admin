import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  type: z.string().optional(),
  /** 左侧类型列表的搜索词（前端过滤，进 URL 只为刷新后恢复） */
  tq: z.string().optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/plugins/dict")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("dict:type:add"),
  staticData: { title: "数据字典" },
  component: () => null,
})
