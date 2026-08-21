import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireSuperUser } from "@admin/platform/auth/guards"

const searchSchema = z.object({
  /** 名称/描述关键字 */
  q: z.string().optional(),
  /** '1' 启用 · '0' 停用 */
  enabled: z.enum(["0", "1"]).optional(),
  tag: z.string().optional(),
})

/**
 * 插件管理。
 *
 * ⚠️ 守卫用 `requireSuperUser()` 而不是 `requirePerm()` ——
 * `/sys/plugins` 全部接口都是 `DependsSuperUser`，而菜单表里这条的 `perms`
 * 是**空串**，`requirePerm()` 检查不到任何东西，等于没设防
 * （和 `/monitors/server`、`/monitors/sessions` 同一类）。
 */
export const Route = createFileRoute("/_auth/system/plugin")({
  validateSearch: searchSchema,
  beforeLoad: requireSuperUser(),
  staticData: { title: "插件管理" },
  component: () => null,
})
