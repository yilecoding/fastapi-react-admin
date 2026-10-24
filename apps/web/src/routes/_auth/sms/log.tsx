import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  size: z.coerce.number().int().positive().optional(),
  /** 以下由 QueryBar 管，键 = 页面里 FIELDS 的 key */
  phone: z.string().optional(),
  // 雪花 ID：`lib/search-params.ts` 把超安全整数范围的纯整数保成字符串（硬纪律 6），这里按 string 收
  config_id: z.string().optional(),
  template: z.string().optional(),
  status: z.coerce.number().int().optional(),
  error_kind: z.string().optional(),
  time: z.string().optional(),
  /** 摆开但没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
})

export const Route = createFileRoute("/_auth/sms/log")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sms:log:list"),
  staticData: { title: "发送日志" },
  component: () => null,
})
