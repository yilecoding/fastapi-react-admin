import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).optional(),
  name: z.string().optional(),
  /** 与后端 FileType 枚举一致 */
  type: z.enum(["image", "document", "video", "audio", "archive", "other"]).optional(),
  /** 宫格 / 列表。进 URL 才能刷新后保持 —— <Activity> 只在会话内保活 */
  view: z.enum(["grid", "list"]).optional(),
})

/**
 * 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限。
 *
 * 守卫用 `sys:file:list`（这一页专门建了这个权限码），而不是像别的页面那样
 * 借 add/del —— 「能不能看列表」和「能不能上传」本来就该分开。
 */
export const Route = createFileRoute("/_auth/system/file")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:file:list"),
  staticData: { title: "文件管理" },
  component: () => null,
})
