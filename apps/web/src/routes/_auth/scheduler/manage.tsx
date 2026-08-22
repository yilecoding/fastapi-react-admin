import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 键 = `pages/scheduler-manage` 里 `FIELDS` 的 `key` */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  name: z.string().optional(),
  task: z.string().optional(),
  /** 'true' / 'false' —— 走查询区的 select，值是字符串 */
  enabled: z.string().optional(),
  /** 摆开但还没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
})

/**
 * 用 `task:scheduler:edit` 当门槛：这一页的主要用途就是改调度，
 * 只读的人去「执行记录」页看结果就够了（那页不设权限）。
 */
export const Route = createFileRoute("/_auth/scheduler/manage")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("task:scheduler:edit"),
  staticData: { title: "任务调度" },
  component: () => null,
})
