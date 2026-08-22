import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

import { requireSuperUser } from "@admin/platform/auth/guards"

/**
 * 在线用户（会话监控）。后端 `GET /monitors/sessions` 是 `DependsSuperUser`。
 *
 * path 曾经是 `/log/online`（历史命名残留，父节点「系统监控」明明是 `/monitor`）。
 * 2026-08-22 迁到 `/monitor/online`，和兄弟节点 `/monitor/redis`、`/monitor/server`
 * 对齐——连同 `sys_menu` 种子数据、page-registry、i18n key、仪表盘跳转链接一起改，
 * 不是单改这一个文件，所以不会出现旧注释担心的"菜单变死链"。
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

export const Route = createFileRoute("/_auth/monitor/online")({
  validateSearch: searchSchema,
  beforeLoad: requireSuperUser(),
  staticData: { title: "在线用户" },
  component: () => null,
})
