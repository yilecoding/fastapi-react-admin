import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  /** 一次性确认令牌（`cf_` 开头，见 dispatcher 的注释：前缀是为了不被当成数字解析） */
  token: z.string().optional(),
})

/** MCP 发起的写操作回网页确认。不进侧边栏：只从外部系统给的链接进来 */
export const Route = createFileRoute("/_auth/ai/confirm")({
  validateSearch: searchSchema,
  // 和确认接口同一个权限：看得到却点不了，等于死胡同
  beforeLoad: requirePerm("ai:chat:use"),
  staticData: { title: "确认 AI 操作" },
  component: () => null,
})
