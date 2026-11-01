import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"

const searchSchema = z.object({
  /**
   * 公告卡 / 未读消息卡里就地打开的那一条（#186，硬纪律 2：开着哪条进 URL，刷新还在）。
   * 雪花 ID 一律字符串（硬纪律 6）；`coerce` 兜 `?notice=123` 这种被解析成 number 的小数字
   */
  notice: z.coerce.string().optional(),
  /** 待办卡里就地打开的审批单（#202），同上 */
  wf: z.coerce.string().optional(),
  /** 编辑工作台（#202）。`catch`：手敲一个认不出来的值不该让整页 validateSearch 失败 */
  edit: z.boolean().optional().catch(undefined),
  /** 「待我处理」的分段（#202）；不写 = 全部。认不出来的值回落成「全部」，不让整页 validateSearch 失败 */
  todo: z.enum(["approve", "back", "draft"]).optional().catch(undefined),
})

/**
 * 页面组件不在这里渲染 —— 由 TabOutlet 统一挂载（见 _auth.tsx）。
 * 这里只负责：search schema、staticData、权限守卫。
 *
 * 不挂权限码：工作台是登录后的落地页，人人都有（#186 / #202）；
 * 每张卡片自己声明要什么权限，没权限的卡片不渲染（`pages/dashboard/cards/registry.ts`）。
 */
export const Route = createFileRoute("/_auth/dashboard")({
  validateSearch: searchSchema,
  staticData: { title: "仪表盘" },
  component: () => null,
})
