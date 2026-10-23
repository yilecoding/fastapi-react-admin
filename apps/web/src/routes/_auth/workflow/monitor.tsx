import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 视图状态进 URL（硬纪律 2）：筛选 / 分页 / 隐藏的列 / 打开的详情 */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  /** 以下由 QueryBar 管，键 = 页面 FIELDS 里的 key */
  keyword: z.string().optional(),
  // 流程定义 ID 是雪花 —— 只能当字符串（硬纪律 6）
  definition: z.string().optional(),
  initiator: z.string().optional(),
  status: z.enum(["running", "approved", "rejected", "withdrawn", "terminated"]).optional(),
  /** 发起时间区间，`起~止` */
  time: z.string().optional(),
  f: z.string().optional(),
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
  id: z.string().optional(),
  /** 1 = 打开着「AI 预审一致率」抽屉 */
  stats: z.coerce.number().int().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/workflow/monitor")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("workflow:instance:list"),
  staticData: { title: "实例监控" },
  component: () => null,
})
