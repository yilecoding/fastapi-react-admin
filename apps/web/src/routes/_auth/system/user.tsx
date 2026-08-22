import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/**
 * 视图状态进 URL —— 这是硬纪律之一：
 * Activity 保活只在会话内有效，刷新页面全丢；search params 才是跨刷新的持久层。
 */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  username: z.string().optional(),
  status: z.coerce.number().int().optional(),
  phone: z.string().optional(),
  // 部门/角色 id 是雪花 —— 只能当字符串，Number() 会掉精度
  dept: z.string().optional(),
  role: z.string().optional(),
  /** 摆开但还没填值的格子，逗号分隔；运算符不是默认值时写成 `key:op` */
  f: z.string().optional(),
  /** 被隐藏的列 id，逗号分隔（视图状态进 URL） */
  hide: z.string().optional(),
  // 没有 `adv`：这一页没开 `advanced`（后端没有过滤 DSL）
})

/**
 * 页面组件不在这里渲染 —— 由 TabOutlet 统一挂载（见 _auth.tsx）。
 * 这里只负责：search schema、staticData、权限守卫。
 */
export const Route = createFileRoute("/_auth/system/user")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:user:del"),
  staticData: { title: "用户管理" },
  component: () => null,
})
