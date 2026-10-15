import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  /**
   * 当前会话 ID。
   * ⚠️ 是**雪花字符串**，这里必须是 `z.string()` —— 用 `z.coerce.number()`
   * 会让 2210000000000000001 这种值塌成另一个数（硬纪律 6）
   */
  c: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/ai/chat")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("ai:chat:use"),
  staticData: { title: "对话助手" },
  component: () => null,
})
