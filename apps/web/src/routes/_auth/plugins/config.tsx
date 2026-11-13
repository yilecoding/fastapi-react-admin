import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/**
 * 参数配置（`plugin/config` 插件）。
 *
 * 页面入口与后端查询接口统一要求 `sys:config:list`，
 * 保存配置由页面内的 `sys:config:edit` 单独控制。
 */
const searchSchema = z.object({
  /** 左栏选中的分类：LOGIN / USER_SECURITY / EMAIL / AI / other */
  group: z.string().optional(),
  /** 名称 / 键名 / 说明关键字。给了就跨全部分类搜 */
  q: z.string().optional(),
})

// 刻意**没有** page/size：设置屏不分页，一次把整类铺完。
// schema 里留着分页参数而界面上没有分页条是禁止的（见 CLAUDE.md 组件约定）。

export const Route = createFileRoute("/_auth/plugins/config")({
  validateSearch: searchSchema,
  beforeLoad: requirePerm("sys:config:list"),
  staticData: { title: "参数配置" },
  component: () => null,
})
