import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/** 键 = `pages/open-log` 里 `fields` 的 `key` */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  /** 应用 ID —— 雪花，必须是字符串（硬纪律 6；`lib/search-params.ts` 保证超安全整数不被 JSON.parse 截断） */
  app: z.string().optional(),
  status: z.coerce.number().int().optional(),
  error_code: z.string().optional(),
  path: z.string().optional(),
  ip: z.string().optional(),
  /** `2026-10-21 00:00:00~2026-10-21 23:59:59`，两端都可省 */
  time: z.string().optional(),
  f: z.string().optional(),
  hide: z.string().optional(),
  /** 可移动列的顺序，逗号分隔（`pages/_shared/use-column-order.ts`）；默认顺序不写 */
  cols: z.string().optional(),
})

/**
 * 调用日志**不进侧边栏**（`sys_menu` 里只有它的按钮权限 `open:log:list`，挂在「应用管理」下）：
 * 从应用管理的「调用日志」按钮 / 行操作 / 「最近调用」进来，在标签页里打开。同 `/ai/confirm` 的做法
 */
export const Route = createFileRoute("/_auth/open/log")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("open:log:list"),
  staticData: { title: "调用日志" },
  component: () => null,
})
