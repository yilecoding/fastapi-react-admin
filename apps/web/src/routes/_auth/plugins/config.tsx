import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requirePerm } from "@admin/platform/auth/guards"

/**
 * 参数配置（`plugin/config` 插件）。
 *
 * 读接口只要 `DependsJwtAuth`，但这一页的用途就是改配置，
 * 所以守卫按「能编辑」来 —— 只能看的人进来只会看到一堆改不动的输入框。
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
  beforeLoad: requirePerm("sys:config:edit"),
  staticData: { title: "参数配置" },
  component: () => null,
})
