import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireAuth } from "@admin/platform/auth/guards"

/**
 * 内嵌页面的宿主路由（后端菜单类型 3 = embedded）。
 *
 * **刻意不写 `staticData.title`** —— 内嵌页每个的名字都不一样，
 * `use-sync-tabs` 在 `staticData.title` 缺失时会回退到后端菜单树的 `meta.title`，
 * 写死一个「内嵌页面」会让所有内嵌 tab 长得一模一样、分不清哪个是哪个。
 */
export const Route = createFileRoute("/_auth/embedded/$name")({
  validateSearch: z.object({}),
  beforeLoad: requireAuth,
  component: () => null,
})
