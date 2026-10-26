import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  size: z.coerce.number().int().positive().optional(),
  /** 以下由 QueryBar 管，键 = 页面里 FIELDS 的 key */
  kind: z.string().optional(),
  channel: z.string().optional(),
  status: z.string().optional(),
  time: z.string().optional(),
  /** 摆开但没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
})

export const Route = createFileRoute("/_auth/notify/delivery")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:notification:delivery:list"),
  staticData: { title: "投递记录" },
  component: () => null,
})
