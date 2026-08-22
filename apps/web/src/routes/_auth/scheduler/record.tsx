import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

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
  // 没有 `adv`：这一页没开 `advanced`（后端没有过滤 DSL）
})
/**
 * 执行记录是**只读**的，唯一的写操作是「批量删除记录」。
 * 用 `task:result:del` 当门槛会把「只想看看跑得怎么样」的人挡在外面 ——
 * 接口层已经给删除单独挂了 `RequestPermission('task:result:del')`，
 * 这里只要求登录（列表接口本身是 `DependsJwtAuth`）。
 */
export const Route = createFileRoute("/_auth/scheduler/record")({
  validateSearch: searchSchema,
  staticData: { title: "执行记录" },
  component: () => null,
})
