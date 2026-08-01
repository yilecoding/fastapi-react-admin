import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  username: z.string().optional(),
  ip: z.string().optional(),
  status: z.coerce.number().int().optional(),
  start_time: z.string().optional(),
  end_time: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔（视图状态进 URL） */
  hide: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/log/opera")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("log:opera:del"),
  staticData: { title: "操作日志" },
  component: () => null,
})
