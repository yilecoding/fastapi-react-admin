import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  // 左栏角色列表走**滚动加载**，所以这里没有 page/size。
  // 要加回来就必须同时把分页条加回界面 —— schema 里有 page 而界面上没有入口，
  // 等于第 2 页永远不可达（CLAUDE.md 组件约定表里那条）。
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
