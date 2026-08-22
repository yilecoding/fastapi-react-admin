import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  // 左栏范围列表走**滚动加载**，所以这里没有 page/size（与角色页同一套）
  name: z.string().optional(),
  status: z.coerce.number().int().optional(),
  // 选中的数据范围 —— 主从页的选中项也要能刷新恢复
  scope: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/system/data-permission")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("data:scope:add"),
  staticData: { title: "数据权限" },
  component: () => null,
})
