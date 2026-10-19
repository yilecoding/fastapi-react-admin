import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireAuth } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  tab: z.enum(["todo", "done", "initiated", "cc"]).optional(),
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  keyword: z.string().optional(),
  /** 打开着的审批单。雪花 ID 一律字符串（硬纪律 6，`lib/search-params.ts` 保证不被 JSON.parse 掉精度） */
  id: z.string().optional(),
  /** 正在发起的流程编码 */
  start: z.string().optional(),
  /** 重新发起：从这张单复制内容（雪花 ID，字符串） */
  from: z.string().optional(),
})

/**
 * 审批中心。
 *
 * 🔴 守卫是 `requireAuth` 不是 `requirePerm`：审批人通常不在单据的数据范围里、
 * 也不一定有任何管理权限，挂了权限码就有人永远进不来（avc-bp 踩过，#107）。
 * 消息中心里的审批通知链到这里（`?id=`）。
 */
export const Route = createFileRoute("/_auth/workflow/inbox")({
  validateSearch: searchSchema,
  beforeLoad: requireAuth,
  staticData: { title: "审批中心" },
  component: () => null,
})
