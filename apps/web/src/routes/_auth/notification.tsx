import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireAuth } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  title: z.string().optional(),
  /** 0 系统 · 1 公告 · 2 任务事件 */
  category: z.coerce.number().int().optional(),
  /** 1 未读 · 0 已读（用数字不用布尔：`coerce.boolean()` 会把 'false' 判成 true） */
  unread: z.coerce.number().int().optional(),
  /** 摆开但还没填值的格子，逗号分隔；运算符不是默认值时写成 `key:op` */
  f: z.string().optional(),
})

/**
 * 消息中心。
 *
 * 🔴 守卫是 `requireAuth` 而不是 `requirePerm` —— **收件箱不挂权限码**：
 * 接口按 `current_user.id` 强制过滤，读自己的东西不需要授权；而挂了权限码
 * 就意味着「种子里漏给某个角色配上，那个人永远看不到任何通知」，
 * 而界面上只是「一条都没有」，跟真的没通知分不出来（硬纪律 9）。
 * 顶栏铃铛的「查看全部通知」也会跳到这里，那个入口对所有登录用户都在。
 *
 * 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 守卫。
 */
export const Route = createFileRoute("/_auth/notification")({
  validateSearch: searchSchema,
  beforeLoad: requireAuth,
  staticData: { title: "消息中心" },
  component: () => null,
})
