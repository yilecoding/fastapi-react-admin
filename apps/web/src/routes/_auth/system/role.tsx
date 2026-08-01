import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  name: z.string().optional(),
  status: z.coerce.number().int().optional(),
  // 选中的角色 / 右侧 tab / 「角色用户」子表页码 —— 主从页的视图状态也要能刷新恢复
  role: z.string().optional(),
  tab: z.enum(["perms", "scopes", "users"]).optional(),
  upage: z.coerce.number().int().min(1).optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/system/role")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:role:add"),
  staticData: { title: "角色管理" },
  component: () => null,
})
