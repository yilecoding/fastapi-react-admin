import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  size: z.coerce.number().int().positive().optional(),
  /** 以下由 QueryBar 管，键 = 页面里 FIELDS 的 key */
  tool_name: z.string().optional(),
  status: z.coerce.number().int().optional(),
  time: z.string().optional(),
  /** 摆开但没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
})

export const Route = createFileRoute("/_auth/ai/tool-log")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("ai:log:list"),
  staticData: { title: "调用日志" },
  component: () => null,
})
