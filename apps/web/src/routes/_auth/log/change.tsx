import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 键 = `pages/log-change` 里 `FIELDS` 的 `key`（详见 log/login.tsx 上的说明） */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  entity_type: z.string().optional(),
  /** 雪花 ID：保持字符串（硬纪律 6；`lib/search-params.ts` 让超安全整数范围的纯整数不被 JSON.parse 掉） */
  entity_id: z.string().optional(),
  actor: z.string().optional(),
  action: z.string().optional(),
  source: z.string().optional(),
  field: z.string().optional(),
  trace_id: z.string().optional(),
  /** `2026-08-16~2026-08-22`，两端都可省 */
  time: z.string().optional(),
  /** 摆开但还没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔；默认顺序不写 */
  cols: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/log/change")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("log:change:list"),
  staticData: { title: "数据变更" },
  component: () => null,
})
