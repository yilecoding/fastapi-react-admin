import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 键 = `pages/log-opera` 里 `FIELDS` 的 `key`（详见 log/login.tsx 上的说明） */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  username: z.string().optional(),
  ip: z.string().optional(),
  status: z.coerce.number().int().optional(),
  /** `2026-08-16~2026-08-22`，两端都可省 */
  time: z.string().optional(),
  /** 摆开但还没填值的格子 */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔 */
  hide: z.string().optional(),
  // 没有 `adv`：日志页没开 `advanced`（后端没有过滤 DSL）
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/log/opera")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("log:opera:del"),
  staticData: { title: "操作日志" },
  component: () => null,
})
