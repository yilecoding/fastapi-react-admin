import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  /** 流程定义列表搜索词；列表卸载去设计器、返回和刷新时都要保留 */
  keyword: z.string().optional(),
  /** 正在设计的流程定义。雪花 ID，字符串（硬纪律 6） */
  id: z.string().optional(),
  /** 设计器当前步骤 */
  step: z.enum(["basic", "form", "flow"]).optional(),
  /** 设计器里选中的节点 / 字段 —— 刷新不丢（#107 设计 8） */
  sel: z.string().optional(),
})

/** 页面由 TabOutlet 挂载；这里只声明 search schema / staticData / 权限 */
export const Route = createFileRoute("/_auth/workflow/definition")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("workflow:definition:list"),
  staticData: { title: "流程定义" },
  component: () => null,
})
