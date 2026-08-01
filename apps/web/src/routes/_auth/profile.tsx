import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

const searchSchema = z.object({
  /**
   * 当前面板。前两个是账号相关，后四个来自偏好面板
   * （`packages/platform/src/pages/_shared/preferences-panel.tsx`）。
   *
   * ⚠️ 新增偏好面板时这个枚举要一起加，否则链接会被 zod 挡掉、静默回落到 basic。
   * 原来的 `tab` 参数（basic/security/preferences）已删除 —— 那一层页签没了，
   * 不做兼容（见 CLAUDE.md「还没发版」）。
   */
  section: z
    .enum(["basic", "security", "theme", "layout", "tabs", "reset"])
    .optional(),
})

/**
 * 个人中心。
 *
 * 不加 `requirePerm` —— 菜单表里这条的 `perms` 是空串，而且「改自己的资料」
 * 本来就该对所有登录用户开放，后端那几个接口也只挂了 `DependsJwtAuth`。
 * `_auth` 布局已经保证了登录态。
 */
export const Route = createFileRoute("/_auth/profile")({
  validateSearch: searchSchema,
  staticData: { title: "个人中心" },
  component: () => null,
})
