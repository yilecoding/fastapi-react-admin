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
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
  /** Webhook 抽屉（#167）：应用 ID（雪花，保持字符串 —— 硬纪律 6）· 页签 · 投递记录的状态 / 端点 / 页码 / 打开的那一条 */
  webhook: z.string().optional(),
  wtab: z.enum(["endpoints", "deliveries", "events"]).optional(),
  wstatus: z.string().optional(),
  whook: z.string().optional(),
  wpage: z.coerce.number().int().min(1).optional(),
  wdel: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/open/app")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("open:app:list"),
  staticData: { title: "应用管理" },
  component: () => null,
})
