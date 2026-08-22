import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  title: z.string().optional(),
  /** 0 通知 · 1 公告 */
  type: z.coerce.number().int().optional(),
  /** 0 隐藏 · 1 显示 */
  status: z.coerce.number().int().optional(),
  /** 摆开但还没填值的格子，逗号分隔；运算符不是默认值时写成 `key:op` */
  f: z.string().optional(),
  // 没有 `adv`：这一页没开 `advanced`（后端没有过滤 DSL）
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/plugins/notice")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:notice:add"),
  staticData: { title: "通知公告" },
  component: () => null,
})
