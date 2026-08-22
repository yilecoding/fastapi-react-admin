import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireSuperUser } from "@admin/platform/auth/guards"

/**
 * 在线用户（会话监控）。后端 `GET /monitors/sessions` 是 `DependsSuperUser`。
 *
 * 注意 path 是 `/log/online` 而不是 `/monitor/online` —— 菜单种子数据就是这么定的
 * （`sys_menu` 里父节点是「系统监控」，但 path 归在 log 下），改 path 会让已有菜单变死链。
 */
const searchSchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  size: z.coerce.number().int().min(1).max(100).optional(),
  /** 关键字：账号 / 昵称 / IP */
  q: z.string().optional(),
  /** 1 = 只看在线，0 = 只看离线 */
  online: z.coerce.number().int().min(0).max(1).optional(),
  refresh: z.coerce.number().int().min(0).max(3600).optional(),
  /** 摆开但还没填值的格子，逗号分隔；运算符不是默认值时写成 `key:op` */
  f: z.string().optional(),
  // 没有 `adv`：这一页的筛选全在前端做，用不上条件树
})

export const Route = createFileRoute("/_auth/log/online")({
  validateSearch: searchSchema,
  beforeLoad: requireSuperUser(),
  staticData: { title: "在线用户" },
  component: () => null,
})
