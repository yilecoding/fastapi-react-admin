import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 键 = `pages/scheduler-record` 里 `FIELDS` 的 `key` */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  task_id: z.string().optional(),
  /** `2026-08-16~2026-08-22`，两端都可省 */
  time: z.string().optional(),
  /** 摆开但还没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
  // 没有 `adv`：这一页没开 `advanced`（后端没有过滤 DSL）
})
/**
 * 页面入口和后端列表接口同一个门槛：`task:result:list`（#228 起列表接口要它，
 * 执行结果和 traceback 里可能有敏感参数）。删除另有 `task:result:del`，页面里单独控制。
 *
 * 🔴 原来这里只要求登录，注释写着「列表接口本身是 `DependsJwtAuth`」—— 接口补上权限码之后
 * 这条假设过期了（#405）：没权限的人页面照开、占一个页签，表格里是 403 错误块，而不是跳 `/403`。
 * 工作台「需要你留意」的「看记录」按钮（`pages/dashboard/card-rules.ts`）按同一个码给。
 */
export const Route = createFileRoute("/_auth/scheduler/record")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("task:result:list"),
  staticData: { title: "执行记录" },
  component: () => null,
})
